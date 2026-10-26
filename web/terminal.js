/* Φ phi — Terminal & Tab Manager */

import { PTYWebSocket } from './ws.js';
import { terminalSnapshot, resetTerminalState } from './terminal-state.js';
import { terminalHistoryMethods } from './terminal-history.js';
import { normalizePath } from './sessions.js';
import {
    projectWorktreeLabel,
    formatWorkspaceLabel,
    cpuLevel,
    worktreeGlyph,
    getTerminalActivityState,
    formatTerminalActivityTitle,
    buildSelfHud,
    formatHudLine,
    formatHudCpu,
    formatDurationMin,
    escapeHtml,
    isMacPlatform,
    tabShortcutDigit,
    isCoarseViewport,
    isCompactViewport,
    prefersInputBarFocus,
    terminalPreferredFontSize,
    responsiveTerminalFontSize,
    TERMINAL_TARGET_COLUMNS,
    openExternalLink,
    installTerminalLinkProvider,
    serverKey,
    getEmbeddedProfileId,
} from './util.js';
import { SNAPSHOT_SCROLLBACK_ROWS } from './backend-store.js';
import {
    applyBrandCpuTier,
    applyTerminalActivityIndicator,
} from './header-state.js';
import {
    formatAttachment,
    extractImageItems,
    extractImageFiles,
    uploadClipboardImage,
    formatChipName,
} from './attachments.js';
import {
    executeRecipe,
    recipeFor,
    isOpenCodeMini,
    openCodePaneMode,
    opencodeMiniRecipe,
    logoFor,
    inputMode,
    hasModelSwitch,
    getCoder,
    isShell,
} from './coders.js';
import {
    mountRpcChat,
    rpcChatSend,
    destroyRpcChat,
    getPiRpcStatus,
    getPiRpcControls,
    rpcChatModels,
    rpcChatThinkingLevels,
    rpcChatSetModel,
    rpcChatSetThinking,
    rpcChatReset,
    rpcChatCompact,
    rpcChatInterrupt,
    closePiSubagentViewer,
    rpcChatSetName,
    subscribePiRpcStatus,
    syncPiSubagentStrip,
} from './chat-pi/controller.js';
import { formatPiRpcStatus } from './chat-pi/render.js';
import { ACCENT_COLORS } from './theme.js';

export const DEFAULT_ANSI_THEME = {
    background: '#08080a',
    foreground: '#e4e3e9',
    cursor: '#7c6af7',
    cursorAccent: '#08080a',
    black: '#18181b',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#eab308',
    blue: '#3b82f6',
    magenta: '#a855f7',
    cyan: '#06b6d4',
    white: '#fafafa',
    brightBlack: '#71717a',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#facc15',
    brightBlue: '#60a5fa',
    brightMagenta: '#c084fc',
    brightCyan: '#22d3ee',
    brightWhite: '#ffffff',
};

// getTerminalTheme derives the xterm theme object for a tab.
// Normal tabs and tabs for unselected coders receive the standard
// ANSI palette with only cursor colour updated. When agy_theme_ansi
// is enabled and the coder is agy, ANSI accent slots (blue, cyan,
// magenta) harmonise with Phi's active accent theme while preserving
// semantic red/green/yellow indicators.
export function getTerminalTheme(
    coder,
    accentColorKeyOrHex,
    config,
    activeThemeKey,
    hasCustomBg,
) {
    const isAgyThemed = coder === 'agy' && !!config?.agy_theme_ansi;
    const themeKey =
        activeThemeKey ||
        (typeof document !== 'undefined' &&
            document.documentElement?.getAttribute('data-theme-color')) ||
        'purple';
    const tokens = ACCENT_COLORS?.[themeKey] ||
        ACCENT_COLORS?.purple || {
            accent: '#7c6af7',
            accentDim: '#5b4ec2',
            accentBright: '#9a8dfa',
        };
    const cursorColor =
        accentColorKeyOrHex ||
        (typeof document !== 'undefined' &&
            document.documentElement?.style?.getPropertyValue('--accent')) ||
        tokens.accent;

    const bgActive =
        hasCustomBg !== undefined
            ? !!hasCustomBg
            : typeof document !== 'undefined' &&
              !!document.body?.classList?.contains('has-terminal-bg');
    const background = bgActive
        ? 'rgba(0, 0, 0, 0)'
        : DEFAULT_ANSI_THEME.background;

    if (!isAgyThemed) {
        return {
            ...DEFAULT_ANSI_THEME,
            background,
            cursor: cursorColor,
        };
    }

    return {
        ...DEFAULT_ANSI_THEME,
        background,
        cursor: cursorColor,
        blue: tokens.accentDim,
        brightBlue: tokens.accentBright,
        cyan: tokens.accent,
        brightCyan: tokens.accentBright,
        magenta: tokens.accent,
        brightMagenta: tokens.accentBright,
        selectionBackground: `${tokens.accent}40`,
    };
}

// Pi thinking levels — bonus/pi_themes/phi_violet.json colors:
//  off darkGray #252525 → minimal gray #474747 → low #6d28d9 → medium #ddd6fe → high #a78bfa → xhigh white #e3e3e4
const PI_THINKING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
// Bridge protocol vocabulary (includes max); PI_THINKING_ORDER above is the
// legacy display order where max aliases to xhigh. Keep the two separate.
const PI_BRIDGE_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PI_THINKING_ALIASES = {
    max: 'xhigh',
    none: 'off',
    'x-high': 'xhigh',
    x_high: 'xhigh',
};

function normalizeThinkingLevel(level) {
    const raw = String(level || '')
        .trim()
        .toLowerCase();
    return PI_THINKING_ALIASES[raw] || raw;
}
function thinkingLevelClass(level) {
    const n = normalizeThinkingLevel(level);
    return PI_THINKING_ORDER.includes(n) ? n : 'off';
}

// Native Compact waits at most 125s in the browser against the
// server's 120s bound. Expiry reports unknown; it never cancels
// native provider work and never permits a replay.
const PI_BRIDGE_COMPACT_TIMEOUT_MS = 125_000;

// Fixed Compact reason vocabulary shared with the Go/wire contract.
// Only these words may reach the toast; anything else (including
// word-shaped provider text) is dropped, never rendered.
const PI_BRIDGE_COMPACT_REASONS = new Set([
    'duplicate',
    'stale',
    'busy',
    'queued',
    'compaction-active',
    'pending',
    'unavailable',
    'cancelled',
    'already-compacted',
    'error',
    'uncertain',
]);

// piBridgeContextNumber parses one context telemetry field: HTTP
// numbers and WS decimal strings land here. Missing, empty, null,
// boolean, or unparsable input is unknown (null), never zero.
function piBridgeContextNumber(raw) {
    if (typeof raw === 'number')
        return Number.isFinite(raw) ? raw : null;
    if (
        typeof raw === 'string' &&
        raw !== '' &&
        /^\d+(\.\d+)?$/.test(raw)
    ) {
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    }
    return null;
}

// piBridgeReadinessBool parses one readiness field: HTTP booleans
// and WS true/false strings land here. Anything else is unknown.
function piBridgeReadinessBool(raw) {
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    return null;
}

// piBridgeCapable feature-detects one bridge capability at the
// point of use: Pi PTY, live tab, current socket confirmed fresh,
// managed lease, connected peer, negotiated capability. Never
// sticky, never cached across reconnects. Module-level so the
// ordered-view key can use it without new prototype surface.
function piBridgeCapable(tab, capability) {
    return (
        tab?.coder === 'pi' && !tab.isDead &&
        !!tab.ws && tab._piBridgeFresh === tab.ws &&
        tab.piBridge?.state === 'managed' &&
        tab.piBridge.connected === true &&
        Array.isArray(tab.piBridge.capabilities) &&
        tab.piBridge.capabilities.includes(capability)
    );
}

// piBridgeCompactReady is the one readiness predicate behind both the
// Compact control and the dispatch guard, so an enabled button and a
// dispatched request can never disagree. The reason is the control's
// title when it is not ready.
function piBridgeCompactReady(view) {
    const known =
        typeof view?.generation === 'string' &&
        view.generation !== '' &&
        typeof view?.telemetry_revision === 'string' &&
        view.telemetry_revision !== '' &&
        typeof view?.compact_idle === 'boolean' &&
        typeof view?.compact_queued === 'boolean' &&
        typeof view?.compact_active === 'boolean' &&
        typeof view?.compact_pending === 'boolean';
    if (!known)
        return {
            ready: false,
            reason: 'Compact unavailable: unknown Pi state',
        };
    // A sampled idle flag does not override a logically running
    // runtime; an unknown (absent) running flag stays ready.
    if (view.compact_idle !== true || view.running === true)
        return { ready: false, reason: 'Compact unavailable: Pi is busy' };
    if (view.compact_queued === true)
        return {
            ready: false,
            reason: 'Compact unavailable: messages queued',
        };
    if (view.compact_active === true)
        return {
            ready: false,
            reason: 'Compact unavailable: compaction active',
        };
    if (view.compact_pending === true)
        return {
            ready: false,
            reason: 'Compact unavailable: compaction pending',
        };
    return { ready: true, reason: 'Compact via bridge' };
}

// piBridgeEqualRevAgrees compares the retained publication fields:
// an equal revision must agree on identity and telemetry, while
// connected alone may flip to propagate peer-down. Lifecycle fields
// (running, last_run, last_outcome) are deliberately NOT compared:
// the settled path mutates them without advancing the publication
// revision, so a same-revision peer-down carrying newer settlement
// metadata must still adopt availability.
function piBridgeEqualRevAgrees(current, view) {
    const text = (record, key) =>
        typeof record?.[key] === 'string' ? record[key] : '';
    const count = (record, key) =>
        typeof record?.[key] === 'number' ? record[key] : null;
    const flag = (record, key) =>
        typeof record?.[key] === 'boolean' ? record[key] : null;
    const caps = (record) => (record?.capabilities || []).join(',');
    return (
        text(current, 'generation') === text(view, 'generation') &&
        text(current, 'model') === text(view, 'model') &&
        text(current, 'thinking_level') === text(view, 'thinking_level') &&
        caps(current) === caps(view) &&
        count(current, 'context_tokens') ===
            count(view, 'context_tokens') &&
        count(current, 'context_window') ===
            count(view, 'context_window') &&
        count(current, 'context_percent') ===
            count(view, 'context_percent') &&
        flag(current, 'compact_idle') === flag(view, 'compact_idle') &&
        flag(current, 'compact_queued') ===
            flag(view, 'compact_queued') &&
        flag(current, 'compact_active') ===
            flag(view, 'compact_active') &&
        flag(current, 'compact_pending') === flag(view, 'compact_pending')
    );
}

// Shared "session done" chime. Constructing a new Audio per chime
// re-fetches bell.wav; one object per page is enough.
let doneChimeAudio = null;

// CODER_FAVICONS is a *fallback-only* map for UI pseudo-tabs
// (review, kanban, pi-rpc) that the registry does not advertise.
// Built-in coder favicons (opencode, claude, agy, pi, bash, pwsh)
// come from the registry via logoFor(id) — exported by coders.js.
// Keep this map only for entries the registry does not advertise.
const CODER_FAVICONS = {
    'pi-rpc': 'vendor/logos/pi.png',
    review: 'vendor/logos/review.png',
    kanban: 'vendor/logos/kanban.png',
};

// Automatic-reconnect retry policy: full-jitter exponential backoff.
// Attempt n (1-based) waits random(0, min(CAP, 1s * 2^(n-1))). Referenced by
// maybeAutoReconnect and the reconnect overlay's attempt counter.
const AUTO_RECONNECT_MAX_ATTEMPTS = 10;
const AUTO_RECONNECT_MAX_DELAY_MS = 20000;
// Floor under every redial. Full jitter alone can return ~0ms, which turned a
// flapping PTY into a near-instant hammer loop against the server.
const AUTO_RECONNECT_GRACE_MS = 1000;
// Gap between the steps of pi's /model sequence. Time only -- long enough for
// pi-tui to render the autocomplete before Esc dismisses it, and to settle
// after the dismissal before Enter commits.
const PI_MODEL_STEP_MS = 200;
// How long a socket must stay up before it counts as a successful connection
// rather than a failed attempt that happened to reach onopen.
const AUTO_RECONNECT_STABLE_MS = 5000;

// Configuration for performance marks and the bounded screen-checkpoint
// pipeline: hot live stream plus cold recording fetch.
const PERF_SLOW_MS = 16;
// Max delta and checkpoint limits: 2 MiB bounds live payloads while
// ensuring terminal history is never dropped or truncated on attach.
const MAX_DELTA_BYTES = 2 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_CHARS = 64 * 1024;
// Full live scrollback, desktop and unset-mobile alike. The mobile lane
// below references this — never a second literal.
const LIVE_SCROLLBACK_ROWS = 10000;
// A phone checkpoint is an instant screen restore, not an archive copy.
// Older output remains in the recording and uses the existing history pager.
const PHONE_CHECKPOINT_ROWS = 256;
// Coarse-pointer terminals paint a recent byte window, then replace it with
// adjacent recording windows on scroll. Both the request and resident xterm
// buffer stay bounded independently of session age.
const HISTORY_WINDOW_BYTES = MAX_DELTA_BYTES;
// Anchor the bounded write batches at actual retained rows. If only the
// ending cursor survives a dense page, retreat by a small byte step instead.
// That step cannot cross the entire resident buffer, even for one-byte lines.
const HISTORY_ANCHOR_BYTES = MAX_WRITE_CHARS;
const HISTORY_MIN_STEP_BYTES = 4 * 1024;
// A bounded recording span can arrive in several positive-progress parts.
// No client byte/hash cache participates in recovery.
// After output stays quiet this long, the client uploads a screen
// checkpoint so the next attach restores instantly.
const CHECKPOINT_QUIET_MS = 2000;

function termPerfMark(name) {
    try {
        if (typeof performance !== 'undefined' && performance.mark)
            performance.mark(`phi:${name}`);
    } catch (_e) {}
}
function termPerfMeasureBetween(name, startTs, endTs) {
    try {
        if (
            typeof performance !== 'undefined' &&
            performance.measure &&
            typeof startTs === 'number'
        ) {
            const dur = (endTs ?? performance.now()) - startTs;
            performance.measure(`phi:${name}`, {
                start: startTs,
                duration: dur,
            });
            return dur;
        }
    } catch (_e) {}
    return 0;
}
// Tablet-gate readout without devtools: one greppable console line per
// attach, one warn per genuinely slow fit. Remote-console copy-paste is
// the only measurement path on the weak device, so these stay terse.
// Exported for the threshold contract test; production import graph
// is unaffected.
export function termPerfLogSlowFit(ms, cols, rows, bufLen) {
    if (ms >= 50)
        console.warn(
            `[phi-perf] slow fit: ${ms.toFixed(0)}ms grid=${cols}x${rows} buf=${bufLen}`,
        );
}
function termPerfMeasureSince(name, startTime) {
    try {
        const dur = performance.now() - startTime;
        if (
            dur >= PERF_SLOW_MS &&
            typeof performance !== 'undefined' &&
            performance.measure
        )
            performance.measure(`phi:${name}`, {
                start: startTime,
                duration: dur,
            });
        return dur;
    } catch (_e) {
        return 0;
    }
}

/**
 * Inspects the terminal buffer around the cursor line to distinguish
 * between an actively running process (e.g. spinning animated spinners,
 * thinking indicators) vs a completed task resting at an interactive prompt.
 *
 * @param {import('@xterm/xterm').Terminal} term
 * @returns {{ hasSpinner: boolean, hasPrompt: boolean, promptLine: string }}
 */
export function detectTerminalBufferState(term) {
    if (!term?.buffer?.active) {
        return { hasSpinner: false, hasPrompt: false, promptLine: '' };
    }

    const buffer = term.buffer.active;
    const cursorY = buffer.cursorY ?? 0;
    const baseY = buffer.baseY ?? 0;
    const currentLineIdx = baseY + cursorY;

    // Scan lines in the vicinity of the cursor (where spinners and prompts live)
    const startLine = Math.max(0, currentLineIdx - 4);
    const endLine = Math.min((buffer.length || 1) - 1, currentLineIdx + 2);

    let hasSpinner = false;
    let hasPrompt = false;
    let promptLine = '';

    // Braille patterns: universal CLI spinners (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏, ⣾⣽⣻⢿⡿⣟⣯⣷, ⠁⠂⠄⡀⢀⠠⠐⠈)
    // Geometric / circle / arrow spinners: ◐◓◑◒◜◝◞◟←↖↑↗→↘↓↙▖▘▝▗
    // Progress blocks: ▓▒░
    const SPINNER_CHARS_RE = /[\u2800-\u28FF◐◓◑◒◜◝◞◟▖▘▝▗←↖↑↗→↘↓↙▓▒░]/;

    // Active status keywords indicating work in flight
    const ACTIVE_STATUS_RE =
        /\b(?:thinking|running|executing|working|generating|searching|compiling|building|fetching|loading|installing|waiting|processing)\b/i;

    // Trailing word with ellipsis indicating continuous action: e.g. "Thinking…", "Running bash…"
    const ELLIPSIS_ACTION_RE = /\b[a-zA-Z]{3,}(?:…|\.{3})\b/;

    // Interrupt / cancel hints indicating the process is currently running
    const RUNNING_HINT_RE =
        /(?:esc to (?:interrupt|cancel)|ctrl\+c to (?:interrupt|cancel)|\([0-9.]+s\b)/i;

    // Interactive prompt regex (matches prompts waiting for user input):
    // e.g. ">", "> ", "│ > │", "$ ", "user@host:~$ ", "repo (main) ❯ ", "pi> ", "agy> ", "opencode> "
    const PROMPT_RE =
        /^\s*(?:[│|]\s*)?(?:[\w\s().@:~/-]+?[$#%❯>]|agy>|opencode>|pi>|claude>|[>❯$#%])\s*[│|]?\s*$/;

    // First, scan lines in the window for any active spinner or in-progress indicators
    for (let idx = startLine; idx <= endLine; idx++) {
        const lineObj = buffer.getLine?.(idx);
        if (!lineObj) continue;
        const lineText =
            typeof lineObj.translateToString === 'function'
                ? lineObj.translateToString(true)
                : String(lineObj);
        if (!lineText) continue;

        if (
            SPINNER_CHARS_RE.test(lineText) ||
            ACTIVE_STATUS_RE.test(lineText) ||
            ELLIPSIS_ACTION_RE.test(lineText) ||
            RUNNING_HINT_RE.test(lineText)
        ) {
            hasSpinner = true;
            break;
        }
    }

    // If an active spinner or in-progress indicator is found, the process is definitively spinning/running!
    if (hasSpinner) {
        return { hasSpinner: true, hasPrompt: false, promptLine: '' };
    }

    // Otherwise, check if the cursor line or the immediately preceding non-empty line is a prompt
    const candidateIndices = [currentLineIdx, currentLineIdx - 1];
    for (const idx of candidateIndices) {
        if (idx < 0 || idx >= (buffer.length || 0)) continue;
        const lineObj = buffer.getLine?.(idx);
        if (!lineObj) continue;
        const lineText =
            typeof lineObj.translateToString === 'function'
                ? lineObj.translateToString(true)
                : String(lineObj);
        if (!lineText) continue;

        if (PROMPT_RE.test(lineText)) {
            hasPrompt = true;
            promptLine = lineText;
            break;
        }
    }

    return { hasSpinner: false, hasPrompt, promptLine };
}

export class TabManager {
    constructor(app) {
        this.app = app;
        this.tabs = new Map(); // paneId -> TabInfo
        this.activePaneId = null;

        this.tabsContainer = document.getElementById('tabs-container');
        this.terminalsWrapper = document.getElementById('terminals-wrapper');
        this.inputBarContainer = document.getElementById('input-bar-container');
        this.inputTextArea = document.getElementById('input-textarea');
        this.attachmentStrip = document.getElementById('attachment-strip');
        this.stagedAttachments = []; // Attachment[] — populated by drop/paste, drained by send
        this.lastCpuPercent = null; // updated by applyCPUIndicator; read by the self-HUD popover
        // Last-seen window dims for classifyGeometryChange. On touch
        // shells a height-only change is the software keyboard, which
        // must NEVER refit (frozen rows) — see setupEventListeners.
        this._lastWindowW =
            typeof window !== 'undefined' ? window.innerWidth : 0;
        this._lastWindowH =
            typeof window !== 'undefined' ? window.innerHeight : 0;
        // Prompt history. Alt+Up / Alt+Down on the textarea cycles through
        // previously-sent prompts in the active cwd. _historyCursor is the
        // index into _historyCache for the currently-shown entry; -1 means
        // no entry shown (the textarea holds fresh text the user is typing).
        this._historyCache = []; // newest-first: index 0 = most recent entry
        this._historyCursor = -1; // -1 = free-form, ≥0 = showing cache[idx]
        this._historyCwd = ''; // cwd the cache was loaded for
        this._historyLoaded = false; // first Alt+Up needs a fetch
        // One Pi snapshot per staged-box recall cycle; never persisted.
        this._piRecall = null;
        this.selfHudEl = document.getElementById('self-hud-popover');
        this.selfHudOpen = false;
        this.selfHudCloseTimer = null;
        this.sendInputBtn = document.getElementById('send-input-btn');
        this.cancelInputBtn = document.getElementById('cancel-input-btn');
        this.copyInputBtn = document.getElementById('copy-input-btn');

        // On pagehide, leave a fresh screen checkpoint behind so the next
        // client restores instantly instead of falling back to the bounded
        // delta.
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', () => {
                this.saveActiveDraft();
                for (const tab of this.tabs.values()) {
                    if (tab.serializeAddon && !tab.isDead) {
                        this._uploadCheckpoint(tab);
                    }
                }
            });
        }
        this.directModeToggle = document.getElementById('direct-mode-toggle');
        this.presetsContainer = document.getElementById('presets-container');
        this.piRpcStatusBar = document.getElementById('pi-rpc-status-bar');
        this.piThinkingBtn = document.getElementById('pi-thinking-btn');
        this._piThinkingLevels = new Map(); // paneId -> thinking level (pi PTY local)
        this._piAvailableThinking = new Map(); // paneId -> string[] from Pi
        this._piLastModel = new Map(); // paneId -> model string (for cache invalidation)
        this._thinkingAllVisible = new Map(); // paneId -> bool (global thinking visibility)
        this._piRpcThinkingPending = null;
        this._piRpcResetPending = new Set();
        this._piRpcMenuRequest = 0;
        this._piBridgeThinkingMenuRequest = 0;
        this._piRpcModels = null;
        this._piRpcModelsNote = null;
        this._piRpcModelMemory = new Map();
        this._piRpcModelNextByPane = new Map();
        this._piRpcModelInflight = new Map();
        this._piRpcModelQuery = '';
        this._piRpcModelExpandedGroup = null;
        this._piBridgeSkills = null;
        this._piBridgeSkillQuery = '';
        this._piBridgeSkillsTruncated = false;
        this._piBridgeSkillsUnavailable = false;
        // A failed refresh keeps the last good rows; this marks them
        // as possibly out of date until a refresh succeeds.
        this._piBridgeSkillsStale = false;
        this._piBridgeSkillsRequest = 0;
        this._piBridgeSkillsContext = null;
        // Pending invocations are per pane: one pane's dispatch never
        // hides another pane's outcome.
        this._piBridgeSkillPending = new Map();
        this._piRpcFavorites = null;
        this._piRpcFavoritesLoaded = false;
        this._piRpcModelAutoOpened = false;
        this._piRpcStatusUnsubscribe = subscribePiRpcStatus(
            (paneId, status) => {
                this._promotePiRpcSessionPath(paneId, status);
                // The backend resolves the native Pi session name, the request
                // fallback, and the generic label into one title. Apply it to
                // the tab and persist only on an actual change.
                const nextTitle = status?.title;
                if (typeof nextTitle === 'string' && nextTitle.trim()) {
                    const tab = this.tabs.get(paneId);
                    if (
                        tab &&
                        tab.coder === 'pi-rpc' &&
                        this._setTabTitle(tab, nextTitle)
                    ) {
                        this.savePiRpcTabs();
                    }
                }
                // Model change Invalidates thinking-level cache (different model → different set)
                const m = status?.model ?? getPiRpcStatus(paneId)?.model ?? '';
                const prev = this._piLastModel?.get(paneId);
                if (m && prev !== undefined && m !== prev) {
                    this._piAvailableThinking?.delete(paneId);
                }
                if (!this._piLastModel) this._piLastModel = new Map();
                if (m) this._piLastModel.set(paneId, m);
                else if (status === null) {
                    this._piLastModel.delete(paneId);
                    this._piAvailableThinking?.delete(paneId);
                }
                this.renderPiRpcStatusBar();
                const activeTab = this.getActiveTab();
                if (
                    activeTab?.paneId === paneId &&
                    activeTab.coder === 'pi-rpc'
                ) {
                    this.renderPresets('pi-rpc');
                }
            },
        );
        this.ctrlTBtn = document.getElementById('ctrl-t-btn');
        this.lastInputValue = '';

        if (isCompactViewport() && this.inputTextArea) {
            this.inputTextArea.placeholder = 'Type a prompt...';
        }

        this.setupEventListeners();

        // Prompt for OS-level notification permissions on page load if not configured.
        if (
            typeof Notification !== 'undefined' &&
            Notification.permission === 'default'
        ) {
            Notification.requestPermission();
        }

        // Listen for visibility state changes to clear indicators dynamically.
        // Returning to the page (laptop wake, phone unlock, tab switch-back)
        // is also the moment to revive a dead active tab: the PTY survives
        // detach server-side for 30 minutes, so an immediate redial repaints
        // it from the replay buffer.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                const activeTab = this.getActiveTab();
                if (activeTab?.isAttention) {
                    this._setTabAttention(activeTab, false);
                    this.updateDocumentTitle();
                }
                this._reviveActiveTabIfDead();
                this._queueActiveRefresh();
            }
        });
        // Network restore, bfcache restore and window focus are the "we may have
        // silently lost the socket" signals. The helper is idempotent (config
        // gate + reconnectInFlight guard), so overlapping firings are harmless.
        const resumeViewport = () => { this._reviveActiveTabIfDead(); this._queueActiveRefresh(); };
        for (const event of ['online', 'pageshow', 'focus', 'phi:desktop-wake']) window.addEventListener(event, resumeViewport);
        document.fonts?.ready?.then(() => this._queueActiveRefresh());
        document.fonts?.addEventListener?.('loadingdone', () => this._queueActiveRefresh());

        // Initialise the 1-second background visual idle and prompt detection loop.
        // Also poll CPU stats independently so a stats fetch failure cannot
        // break the idle/notification path (CPU is decorative, never load-bearing).
        setInterval(() => {
            this.pollTerminalIdleAndNotifications();
        }, 1000);
        setInterval(() => {
            this.pollSystemCPU();
        }, 2000);
    }

    /**
     * Fetch current system CPU% from /api/system/cpu and update the phi
     * logo's CPU state class (.cpu-idle / .cpu-moderate / .cpu-high).
     *
     * Independent of the terminal idle poll — a fetch failure here
     * must NOT break anything else.
     */
    async pollSystemCPU() {
        try {
            const res = await fetch('/api/system/cpu');
            if (!res.ok) return;
            const data = await res.json();
            const cpu = typeof data.cpu === 'number' ? data.cpu : 0;
            this.applyCPUIndicator(cpu);
        } catch (_e) {
            // Silent: decorative feature, never break anything.
        }
    }

    applyCPUIndicator(cpuPercent) {
        // Cache for the self-state HUD so hovering doesn't trigger a fetch.
        // The HUD reads this on every render — polling keeps it fresh.
        this.lastCpuPercent = cpuPercent;
        const status = applyBrandCpuTier(cpuPercent);
        // The tiers are static now, so the change itself has to be what
        // moves. A finite burst costs ~2.4ms/frame for its duration and
        // then nothing, where the old per-tier loops cost that forever
        // (cpu-critical was +87% of a core -- worst exactly when the
        // machine was already loaded). Skipped on the first
        // classification so the page doesn't pop on load.
        if (status === 'changed') {
            const logo = document.querySelector('.brand .logo');
            const brandName = document.querySelector('.brand .brand-name');
            if (logo && brandName) this._flourishBrand([logo, brandName]);
        }
    }

    // Play the one-shot tier-change animation and clean up after itself, so
    // nothing is left animating at rest.
    _flourishBrand(els) {
        for (const el of els) {
            if (!el) continue;
            el.classList.remove('cpu-flourish');
            // Force a reflow so re-adding the class restarts the animation;
            // without it a rapid second tier change would not replay.
            void el.offsetWidth;
            el.classList.add('cpu-flourish');
            const done = () => {
                el.classList.remove('cpu-flourish');
                el.removeEventListener('animationend', done);
                el.removeEventListener('animationcancel', done);
            };
            el.addEventListener('animationend', done);
            el.addEventListener('animationcancel', done);
        }
    }

    loadTabDraft(paneId) {
        try {
            const raw = localStorage.getItem(serverKey(`phi_tab_draft_${paneId}`));
            if (!raw || raw.length > 1024 * 1024) return {};
            const draft = JSON.parse(raw);
            return {
                draft: typeof draft.text === 'string' ? draft.text : '',
                draftAttachments: Array.isArray(draft.attachments)
                    ? draft.attachments.filter(a => a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.path === 'string' && typeof a.type === 'string' && Number.isFinite(a.sizeBytes) && (a.source === 'drop' || a.source === 'paste')).slice(0, 100)
                    : [],
            };
        } catch { return {}; }
    }

    saveTabDraft(tab) {
        if (!tab || tab.coder === 'review' || tab.coder === 'kanban') return;
        try {
            const key = serverKey(`phi_tab_draft_${tab.paneId}`);
            if (!tab.draft && !tab.draftAttachments?.length) {
                localStorage.removeItem(key);
            } else {
                localStorage.setItem(key, JSON.stringify({text: tab.draft || '', attachments: tab.draftAttachments || []}));
            }
        } catch { /* Browser storage must not block typing or switching tabs. */ }
    }

    saveActiveDraft() {
        const tab = this.getActiveTab();
        if (!tab || !this.inputTextArea || tab.coder === 'review' || tab.coder === 'kanban') return;
        tab.draft = this.inputTextArea.value;
        tab.draftAttachments = this.stagedAttachments || [];
        this.saveTabDraft(tab);
    }

    saveTabsState() {
        localStorage.setItem(serverKey('phi_active_pane'), this.activePaneId || '');
        // Tab order is localStorage-only (no backend sync). Drag-reorder
        // mutates the Map; saving the Map's iteration order here keeps the
        // ordering across page reloads in the same browser.
        this.saveTabOrder();
    }

    // The persisted order is a JSON array of paneIds. Stale entries
    // (closed tabs, or paneIds that were renamed during a session restart)
    // are filtered out at restore time - see restoreTabsState.
    saveTabOrder() {
        if (this.restoringTabs) return;
        try {
            localStorage.setItem(
                serverKey('phi_tab_order'),
                JSON.stringify(Array.from(this.tabs.keys())),
            );
        } catch (e) {
            // localStorage can throw in private-mode / quota-exceeded. Failing
            // to persist order shouldn't break tab switching - just log.
            console.warn('phi: failed to save tab order', e);
        }
    }

    savePiRpcTabs() {
        try {
            const piTabs = Array.from(this.tabs.values())
                .filter((t) => t.coder === 'pi-rpc')
                .map((t) => ({
                    paneId: t.paneId,
                    cwd: t.cwd || '',
                    title: t.title || '',
                    workspace: t.workspace || '',
                    sessionPath: this._piRpcStoredSessionPath(t),
                }));
            localStorage.setItem(serverKey('phi_pi_rpc_tabs'), JSON.stringify(piTabs));
        } catch {}
    }

    // Serialize a pi-rpc tab's resume path. An explicit nonempty string is
    // exact; explicit null means Clear removed the path and must NOT fall
    // back to the pane ID. Only legacy in-memory tabs that predate the
    // sessionPath property still decode from pi-rpc:session:<path> panes.
    _piRpcStoredSessionPath(tab) {
        if (tab.sessionPath) return tab.sessionPath;
        if (tab.sessionPath === null) return null;
        return tab.paneId.startsWith('pi-rpc:session:')
            ? decodeURIComponent(tab.paneId.slice('pi-rpc:session:'.length))
            : null;
    }

    // A backend-published sessionPath is file-backed by the manager
    // contract: promote it onto the matching tab and persist, saving only
    // when the stored path actually changes.
    _promotePiRpcSessionPath(paneId, status) {
        const path = status?.sessionPath;
        if (!path) return;
        const tab = this.tabs?.get(paneId);
        if (tab?.coder !== 'pi-rpc' || tab.sessionPath === path) return;
        tab.sessionPath = path;
        this.savePiRpcTabs();
    }

    restorePiRpcTabs() {
        let raw;
        try {
            raw = localStorage.getItem(serverKey('phi_pi_rpc_tabs'));
            if (!raw) return;
            const tabs = JSON.parse(raw);
            if (!Array.isArray(tabs) || tabs.length === 0) return;
            for (const t of tabs) {
                if (!t.paneId || this.tabs.has(t.paneId)) continue;
                const title =
                    t.title ||
                    `Pi RPC · ${t.cwd ? t.cwd.split('/').pop() : t.paneId}`;
                // Only a stored nonempty path resumes; null (Clear) or a
                // legacy missing field mounts a fresh chat. The path is
                // passed into createTab before its first savePiRpcTabs call.
                const sessionPath =
                    typeof t.sessionPath === 'string' && t.sessionPath
                        ? t.sessionPath
                        : null;
                this.createTab(
                    t.paneId,
                    '',
                    title,
                    'pi-rpc',
                    t.workspace || '',
                    t.cwd || '',
                    true,
                    false,
                    '',
                    sessionPath,
                );
                const tab = this.tabs.get(t.paneId);
                if (!tab) continue;
                // Mirror openPiRpcChatTab font wiring so F5 text matches live
                const fontSize = terminalPreferredFontSize(
                    this.app?.terminalFontSize,
                );
                tab.termContainer.style.fontFamily =
                    this.app?.terminalFontFamily || 'JetBrains Mono, monospace';
                tab.termContainer.style.fontSize = `${fontSize}px`;
                try {
                    if (sessionPath)
                        mountRpcChat(
                            t.paneId,
                            tab.termContainer,
                            t.cwd || '',
                            sessionPath,
                        );
                    else mountRpcChat(t.paneId, tab.termContainer, t.cwd || '');
                } catch (e) {
                    console.warn(
                        'phi: failed to restore pi-rpc tab',
                        t.paneId,
                        e,
                    );
                }
            }
        } catch {}
    }

    // ---- Drag-to-reorder (localStorage-only, v0.8.x polish) ----

    _workspaceTabGroups(entries) {
        const workspaces = Array.from(
            new Set(
                entries
                    .map(([, tab]) => tab.workspace || '')
                    .filter(Boolean),
            ),
        );
        const groups = workspaces.map((workspace) => ({
            workspace,
            label: formatWorkspaceLabel(workspace, workspaces),
            entries: [],
        }));
        groups.sort((a, b) => {
            const nameOrder = a.label.localeCompare(b.label, undefined, {
                sensitivity: 'base',
                numeric: true,
            });
            if (nameOrder !== 0) return nameOrder;
            const pathOrder = a.workspace.localeCompare(b.workspace, undefined, {
                sensitivity: 'case',
            });
            if (pathOrder !== 0) return pathOrder;
            if (a.workspace < b.workspace) return -1;
            if (a.workspace > b.workspace) return 1;
            return 0;
        });
        groups.push({ workspace: '', label: 'No workspace', entries: [] });

        const groupsByWorkspace = new Map(
            groups.map((group) => [group.workspace, group]),
        );
        for (const entry of entries) {
            const workspace = entry[1].workspace || '';
            groupsByWorkspace.get(workspace).entries.push(entry);
        }

        const labelCounts = new Map();
        for (const { label } of groups) {
            labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
        }
        for (const group of groups) {
            if (group.workspace && labelCounts.get(group.label) > 1) {
                group.label = group.workspace;
            }
        }
        return groups;
    }

    sortTabsByWorkspace() {
        if (this.tabs.size < 2) return;
        const groups = this._workspaceTabGroups(
            Array.from(this.tabs.entries()),
        );
        // Unread (needing attention) first; workspace grouping stays
        // secondary and each partition keeps its existing order (stable).
        // Closing tabs keep their IDs in the read partition: no unread
        // priority during the undo grace period.
        const unread = [];
        const read = [];
        for (const group of groups) {
            for (const [paneId, tab] of group.entries) {
                (!tab.softClosing && tab.isAttention ? unread : read).push(
                    paneId,
                );
            }
        }
        this.applyTabOrder([...unread, ...read]);
    }

    applySavedTabOrder() {
        let saved = [];
        try {
            const raw = localStorage.getItem(serverKey('phi_tab_order'));
            if (raw) saved = JSON.parse(raw);
        } catch (_e) {
            // Corrupted entry: just ignore and fall back to API order.
            return;
        }
        if (!Array.isArray(saved) || saved.length === 0) return;

        const present = new Set(this.tabs.keys());
        const filtered = saved.filter((id) => present.has(id));
        // Any tabs not in the saved order get appended at the end in the
        // order they currently sit (preserves API order for newly-spawned
        // tabs that the user hasn't touched yet).
        const missing = Array.from(present).filter(
            (id) => !filtered.includes(id),
        );
        const final = [...filtered, ...missing];
        if (final.length !== this.tabs.size) return; // safety
        this.applyTabOrder(final, { persist: false });
    }

    // Reorders both the tabs Map (which drives `this.tabs.keys()` iteration)
    // and the DOM (via appendChild, which moves existing nodes). When
    // `persist` is true, also writes the new order to localStorage.
    applyTabOrder(order, { persist = true } = {}) {
        // Rebuild the Map preserving the new order. TabInfo objects keep
        // their identity (same refs) - we're just rearranging the slots.
        const newMap = new Map();
        for (const id of order) {
            const tab = this.tabs.get(id);
            if (tab) newMap.set(id, tab);
        }
        // Defensive: any tab not in `order` (shouldn't happen) gets appended.
        for (const [id, tab] of this.tabs) {
            if (!newMap.has(id)) newMap.set(id, tab);
        }
        this.tabs = newMap;
        // Reorder DOM children - appendChild on an existing node moves it,
        // doesn't clone it. The terminal-content side (`terminalsWrapper`)
        // is untouched; only the tab strip is reordered.
        for (const id of order) {
            const tabEl = this.tabsContainer.querySelector(
                `[data-pane-id="${id}"]`,
            );
            if (tabEl) this.tabsContainer.appendChild(tabEl);
        }
        if (persist) this.saveTabOrder();
        if (document.body.classList.contains('show-tab-shortcuts')) {
            this.updateTabShortcutHints(true);
        }
        this.updateTabOverflow?.();
        this._refreshOverflowDropdown?.();
    }

    // Splice `sourceId` into the order immediately before or after
    // `targetId`. Returns true if the order actually changed.
    moveTabTo(sourceId, targetId, before) {
        if (sourceId === targetId) return false;
        const order = Array.from(this.tabs.keys());
        const sourceIdx = order.indexOf(sourceId);
        const targetIdx = order.indexOf(targetId);
        if (sourceIdx < 0 || targetIdx < 0) return false;

        order.splice(sourceIdx, 1);
        // After removing source, if source was BEFORE target originally,
        // every later index shifted left by 1. Adjust the target's effective
        // index in the post-removal array before computing the insert slot.
        const targetIdxPost = targetIdx - (sourceIdx < targetIdx ? 1 : 0);
        const insertPos = targetIdxPost + (before ? 0 : 1);
        order.splice(insertPos, 0, sourceId);
        this.applyTabOrder(order);
        return true;
    }

    // Place a newly created tab after the rightmost strip peer with the
    // same nonempty workspace. Visible DOM order is the source of truth:
    // restart reinserts Map keys without moving nodes, so Map order can
    // differ from the strip. Existing tabs never move relative to each other.
    _placeNewTabByWorkspace(paneId) {
        if (this.restoringTabs) return;
        const tab = this.tabs.get(paneId);
        if (!tab) return;
        const desired = [];
        for (const el of this.tabsContainer.children) {
            const id = el.dataset.paneId;
            if (id && this.tabs.has(id)) desired.push(id);
        }
        if (!desired.includes(paneId)) desired.push(paneId);
        const workspace = tab.workspace || '';
        if (workspace !== '') {
            let anchor = null;
            for (const id of desired) {
                if (
                    id !== paneId &&
                    (this.tabs.get(id)?.workspace || '') === workspace
                )
                    anchor = id;
            }
            if (anchor !== null) {
                desired.splice(desired.indexOf(paneId), 1);
                desired.splice(desired.indexOf(anchor) + 1, 0, paneId);
            }
        }
        const mapOrder = Array.from(this.tabs.keys());
        const matchesDom =
            desired.length === this.tabsContainer.children.length &&
            desired.every(
                (id, i) =>
                    this.tabsContainer.children[i].dataset.paneId === id,
            );
        const matchesMap =
            desired.length === mapOrder.length &&
            desired.every((id, i) => mapOrder[i] === id);
        if (!matchesDom || !matchesMap) this.applyTabOrder(desired);
    }

    handleTabDragStart(e, paneId) {
        // Only honor left-button drags. Touch and right-click shouldn't
        // initiate a reorder - the latter opens the context menu (if any).
        if (e.button !== undefined && e.button !== 0) {
            e.preventDefault();
            return;
        }
        this.dragSourceId = paneId;
        try {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', paneId);
        } catch (_) {
            /* some browsers throw if dataTransfer is accessed oddly */
        }
        // Use rAF so the drag image captures the un-faded tab.
        requestAnimationFrame(() => {
            const tabEl = this.tabsContainer.querySelector(
                `[data-pane-id="${paneId}"]`,
            );
            if (tabEl) tabEl.classList.add('dragging');
        });
    }

    handleTabDragEnd(e) {
        const tabEl = e.currentTarget;
        if (tabEl) tabEl.classList.remove('dragging');
        this.clearDropIndicators();
        this.dragSourceId = null;
        this._stopDragAutoScroll();
    }

    // ---- Edge auto-scroll during drag --------------------------------
    //
    // Per-tab dragover only fires when the cursor is OVER a tab. The
    // empty whitespace between/after tabs gets nothing — so even with
    // overflow we can't drag past the visible window. This container-
    // level handler fires over the whitespace (with preventDefault so
    // dragover continues firing), and when the cursor is near the
    // left/right edge, ramps a small horizontal scroll so the strip
    // follows the cursor.
    //
    // Velocity ramp: closer to the edge = faster, capped at ~15px/frame.
    // 48px edge zone is wide enough on trackpads that you don't fight
    // the scroll, narrow enough that mid-strip drags stay put.
    //
    // STATIC so they're available even on `Object.create(prototype)`
    // test harnesses that skip the constructor.
    static _EDGE_ZONE_PX = 48;
    static _EDGE_MAX_VEL = 15; // px per animation frame

    _setupContainerDragHandlers() {
        const strip = this.tabsContainer;
        if (!strip || strip._dragHandlersWired) return;
        strip._dragHandlersWired = true;
        // Initialize drag-scroll state so callers reading from outside
        // (and tests) get 0 rather than undefined on a fresh instance.
        this._dragScrollDir = 0;
        this._dragScrollVel = 0;
        this._dragScrollRaf = null;

        const onDragOver = (e) => {
            // Only act if a tab is being dragged inside phi. If a file
            // from outside is dragged in we still want drop targets to
            // work via the per-tab handlers, but auto-scroll would be
            // a weird experience.
            if (!this.dragSourceId) return;
            const EDGE_ZONE_PX = TabManager._EDGE_ZONE_PX;
            const EDGE_MAX_VEL = TabManager._EDGE_MAX_VEL;
            const rect = strip.getBoundingClientRect();
            const x = e.clientX;
            let dir = 0;
            let prox = 0;
            if (x < rect.left + EDGE_ZONE_PX) {
                dir = -1;
                prox = (rect.left + EDGE_ZONE_PX - x) / EDGE_ZONE_PX;
            } else if (x > rect.right - EDGE_ZONE_PX) {
                dir = 1;
                prox = (x - (rect.right - EDGE_ZONE_PX)) / EDGE_ZONE_PX;
            }
            this._dragScrollDir = dir;
            this._dragScrollVel = Math.min(Math.max(prox, 0), 1) * EDGE_MAX_VEL;
            if (dir !== 0 && !this._dragScrollRaf) {
                this._dragScrollRaf = requestAnimationFrame(() =>
                    this._stepDragAutoScroll(),
                );
            }
            // The whitespace case: we still need to preventDefault so
            // that dragover keeps firing and the drop event is allowed.
            // The per-tab handler does this too, but only over tabs.
            if (!e.defaultPrevented) e.preventDefault();
            try {
                e.dataTransfer.dropEffect = 'move';
            } catch (_) {}
        };

        const onDragLeave = (e) => {
            // Only when the cursor leaves the strip's bounding box
            // entirely (not when sliding between tabs/whitespace inside).
            const to = e.relatedTarget;
            if (to && strip.contains(to)) return;
            // Hit a tab and re-entered its dragover? per-tab keeps things
            // alive. We're only clearing edge-scroll when truly gone.
            // The dragend/drop on a tab will also clear via _stopDragAutoScroll.
        };

        strip.addEventListener('dragover', onDragOver);
        strip.addEventListener('dragleave', onDragLeave);

        // Container-level drop: fires when the user releases over
        // whitespace past the last tab (or before the first). Without
        // this the auto-scroll gets you there but the drop has no
        // target - the reorder silently no-ops.
        strip.addEventListener('drop', (e) => {
            // Only handle drops in the whitespace area. Per-tab drop
            // handlers have already eaten drops that fell on a tab.
            const targetTab = e.target.closest?.('.tab');
            if (targetTab) return; // per-tab already handled
            e.preventDefault();
            this._stopDragAutoScroll();
            if (!this.dragSourceId) return;
            const order = Array.from(this.tabs.keys());
            const sourceIdx = order.indexOf(this.dragSourceId);
            if (sourceIdx < 0) {
                this.dragSourceId = null;
                return;
            }
            const rect = strip.getBoundingClientRect();
            // Cursor past the right edge -> append to end.
            // Cursor before the left edge -> prepend to start.
            const atEnd = e.clientX > rect.right - 4;
            order.splice(sourceIdx, 1);
            if (atEnd) order.push(this.dragSourceId);
            else order.unshift(this.dragSourceId);
            this.applyTabOrder(order);
            this.dragSourceId = null;
        });

        // Mouse wheel: when the strip is overflowing, map vertical wheel
        // to horizontal scroll. Trackpads handle this natively via deltaX
        // but most mice don't, so without this you can scroll horizontally
        // on a trackpad but not on a regular mouse. We do NOT prevent
        // default when there's no horizontal overflow so the page scrolls
        // normally.
        const onWheel = (e) => {
            const overflowX = strip.scrollWidth - strip.clientWidth;
            if (overflowX <= 4) return;
            // Trackpad horizontal gestures come through as deltaX. Mouse
            // vertical wheels come through as deltaY. We accept both.
            const dx =
                Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            if (dx === 0) return;
            // Only consume the event when there's actually room to scroll
            // in the requested direction (so we don't trap a wheel that
            // overshoots).
            const before = strip.scrollLeft;
            strip.scrollLeft = Math.max(
                0,
                Math.min(
                    strip.scrollWidth - strip.clientWidth,
                    strip.scrollLeft + dx,
                ),
            );
            if (strip.scrollLeft !== before) {
                e.preventDefault();
                this.updateTabOverflow();
            }
        };
        strip.addEventListener('wheel', onWheel, { passive: false });
    }

    _stepDragAutoScroll() {
        this._dragScrollRaf = null;
        if (!this._dragScrollDir) return;
        const strip = this.tabsContainer;
        if (!strip) return;
        // Velocity may have been set to 0 if cursor moved to mid-strip;
        // keep the rAF idling so it can pick back up on edge re-entry.
        if (this._dragScrollVel > 0) {
            strip.scrollLeft = Math.max(
                0,
                Math.min(
                    strip.scrollWidth - strip.clientWidth,
                    strip.scrollLeft +
                        this._dragScrollDir * this._dragScrollVel,
                ),
            );
            this.updateTabOverflow();
        }
        this._dragScrollRaf = requestAnimationFrame(() =>
            this._stepDragAutoScroll(),
        );
    }

    _stopDragAutoScroll() {
        this._dragScrollDir = 0;
        this._dragScrollVel = 0;
        if (this._dragScrollRaf) {
            cancelAnimationFrame(this._dragScrollRaf);
            this._dragScrollRaf = null;
        }
    }

    handleTabDragOver(e, targetPaneId) {
        if (!this.dragSourceId || this.dragSourceId === targetPaneId) return;
        // Pin status no longer blocks drag targets - tabs default to
        // pinned so we can't gate on the class. Order is purely visual
        // and handled by moveTabTo's insert-before/after logic.
        const tabEl = e.currentTarget;
        if (!tabEl) return;
        e.preventDefault(); // required so the `drop` event fires
        try {
            e.dataTransfer.dropEffect = 'move';
        } catch (_) {}

        const rect = tabEl.getBoundingClientRect();
        const insertBefore = e.clientX < rect.left + rect.width / 2;
        this.showDropIndicator(tabEl, insertBefore);
    }

    handleTabDragLeave(e) {
        // Only clear when we leave the tab entirely (not when moving between
        // child elements within it - relatedTarget tells us where we went).
        const to = e.relatedTarget;
        if (to && e.currentTarget.contains(to)) return;
        const tabEl = e.currentTarget;
        tabEl.classList.remove('drop-before', 'drop-after');
    }

    handleTabDrop(e, targetPaneId) {
        e.preventDefault();
        const tabEl = e.currentTarget;
        const insertBefore = tabEl.classList.contains('drop-before');
        this.clearDropIndicators();
        if (!this.dragSourceId || this.dragSourceId === targetPaneId) {
            this.dragSourceId = null;
            return;
        }
        this.moveTabTo(this.dragSourceId, targetPaneId, insertBefore);
        this.dragSourceId = null;
    }

    showDropIndicator(tabEl, insertBefore) {
        // Drop indicators are box-shadow classes on the target tab itself
        // (so we never need to measure absolute positions in the scroll
        // container). Only one indicator at a time - clear before showing.
        this.clearDropIndicators();
        tabEl.classList.add(insertBefore ? 'drop-before' : 'drop-after');
    }

    clearDropIndicators() {
        for (const el of this.tabsContainer.querySelectorAll(
            '.drop-before, .drop-after',
        )) {
            el.classList.remove('drop-before', 'drop-after');
        }
    }

    async syncTabs(instances = [], { live = true, screens = null } = {}) {
        this.restoringTabs = true;
        const savedActive = localStorage.getItem(serverKey('phi_active_pane')) || '';
        try {
            const serverIds = new Set(instances.map((t) => t.id ?? t.paneId));
            for (const [paneId, tab] of Array.from(this.tabs.entries())) {
                if (!tab.isKanban && !tab.isReview && tab.coder !== 'pi-rpc' && !tab.softClosing) {
                    if (!serverIds.has(paneId)) {
                        this.disposeTabClient(paneId, { preserveStorage: false });
                    }
                }
            }

            for (const t of instances) {
                const paneId = t.id ?? t.paneId;
                if (this.tabs.has(paneId)) {
                    const tab = this.tabs.get(paneId);
                    tab.sessionId = t.session_id ?? tab.sessionId;
                    tab.workspace = t.workspace ?? tab.workspace;
                    tab.cwd = t.cwd ?? tab.cwd;
                    tab.pinned = !!t.pinned;
                    tab.marked = !!t.marked;
                    tab.tabEl?.classList?.toggle('pinned', tab.pinned);
                    this._setTabTitle(tab, t.title || t.coder || tab.title);
                    if (t.pi_bridge != null) {
                        this._seedHttpPiBridge(tab, t.pi_bridge);
                    }
                    if (live && (tab._detachedCache || !tab.ws) && tab.coder !== 'review' && tab.coder !== 'kanban' && tab.coder !== 'pi-rpc') {
                        tab._detachedCache = false;
                        this._connectTabSocket(tab);
                    }
                } else {
                    const cachedScreen = screens instanceof Map ? screens.get(paneId) : screens?.[paneId] ?? null;
                    const createOpts = (!live || cachedScreen) ? [{ live, cachedScreen }] : [];
                    this.createTab(
                        paneId,
                        t.session_id,
                        t.title || t.coder,
                        t.coder,
                        t.workspace || '',
                        t.cwd || '',
                        !!t.pinned,
                        !!t.marked,
                        '',
                        null,
                        t.coder === 'opencode' ? openCodePaneMode(t.opencode_mode) : null,
                        t.pi_bridge,
                        ...createOpts,
                    );
                }
            }

            if (localStorage.getItem(serverKey('phi_kanban_open')) === '1' && !this.tabs.has('kanban') && this.app?.kanbanManager) {
                await this.app.kanbanManager.openBoard();
            }
            this.restorePiRpcTabs();
            this.applySavedTabOrder();
            if (savedActive && this.tabs.has(savedActive)) {
                this.switchTab(savedActive);
            } else if (instances.length > 0) {
                this.switchTab(instances[0].id ?? instances[0].paneId);
                if (!live && savedActive) {
                    try { localStorage.setItem(serverKey('phi_active_pane'), savedActive); } catch {}
                }
            } else if (this.tabs.size > 0) {
                this.switchTab(Array.from(this.tabs.keys())[0]);
                if (!live && savedActive) {
                    try { localStorage.setItem(serverKey('phi_active_pane'), savedActive); } catch {}
                }
            } else {
                this.showEmptyState();
            }
        } finally {
            this.restoringTabs = false;
            this.saveTabOrder();
        }
    }

    async restoreTabsState(scope = this.app?.scope) {
        localStorage.removeItem('phi_tabs'); // Clear legacy browser storage tabs
        try {
            const fetchFn = (scope && typeof scope.fetch === 'function')
                ? (url, opts) => scope.fetch(url, opts)
                : fetch;
            const res = await fetchFn('/api/terminals');
            if (scope?.aborted) return;
            if (!res.ok) throw new Error('Failed to load server terminal list');
            const instances = await res.json();
            if (scope?.aborted) return;
            const store = this.app?.getActiveStore?.();
            if (store) store.tabs = instances;
            await this.syncTabs(instances, { live: true, screens: store?.screens || null });
        } catch (e) {
            if (e?.name === 'AbortError' || scope?.aborted) return;
            console.error('Failed to restore tabs from server-side state:', e);
        }
    }

    captureBackendState(store) {
        if (!store) return;
        const tabList = [];
        const nextScreens = new Map();
        for (const tab of this.tabs.values()) {
            if (
                tab.softClosing ||
                tab.finalizing ||
                tab.isKanban ||
                tab.isReview ||
                tab.coder === 'kanban' ||
                tab.coder === 'review' ||
                tab.coder === 'pi-rpc'
            ) {
                continue;
            }
            tabList.push({
                id: tab.paneId,
                paneId: tab.paneId,
                session_id: tab.sessionId || '',
                title: tab.title || tab.coder || '',
                coder: tab.coder || '',
                workspace: tab.workspace || '',
                cwd: tab.cwd || '',
                pinned: !!tab.pinned,
                marked: !!tab.marked,
                opencode_mode: tab.opencodeMode || null,
                pi_bridge: tab._piBridgeState || undefined,
            });

            let captured = null;
            if (tab.term && tab.serializeAddon) {
                try {
                    const encoding = tab.term._core?.mouseStateService?.activeEncoding;
                    const mouseMode =
                        encoding === 'SGR'
                            ? '\x1b[?1006h'
                            : encoding === 'SGR_PIXELS'
                              ? '\x1b[?1016h'
                              : '';
                    const snap =
                        terminalSnapshot(tab.term, tab.serializeAddon, {
                            scrollback: SNAPSHOT_SCROLLBACK_ROWS,
                        }) || '';
                    const ansi = mouseMode + snap;
                    if (ansi) {
                        captured = {
                            ansi,
                            cols: tab.term.cols || 80,
                            rows: tab.term.rows || 24,
                        };
                    }
                } catch (e) {
                    console.warn('[term] snapshot on leave failed:', e);
                }
            }
            if (!captured && tab._cachedScreen) {
                captured = tab._cachedScreen;
            } else if (!captured && store.screens?.has(tab.paneId)) {
                captured = store.screens.get(tab.paneId);
            }
            if (captured) {
                nextScreens.set(tab.paneId, captured);
            }
        }
        store.tabs = tabList;
        store.screens = nextScreens;
    }

    paintFromStore(store) {
        if (!store || !Array.isArray(store.tabs)) return false;
        void this.syncTabs(store.tabs, { live: false, screens: store.screens });
        return true;
    }

    setupEventListeners() {
        document.addEventListener('keydown', (e) =>
            this.handleGlobalTabShortcuts(e),
        );
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Alt') {
                this.updateTabShortcutHints(true);
            }
        });
        window.addEventListener('keyup', (e) => {
            if (e.key === 'Alt') {
                this.updateTabShortcutHints(false);
            }
        });
        window.addEventListener('blur', () => {
            this.updateTabShortcutHints(false);
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.updateTabShortcutHints(false);
            }
        });

        // Hover preview card (glassmorphism, big hieroglyph). Shows on
        // mouseover of a tab so users can identify the worktree at a
        // glance without reading the path. Hides on mouseout or scroll.
        this._initHieroPreview();

        // Container-level drag-and-drop wiring: edge auto-scroll + drop-into-
        // whitespace. Per-tab drag handlers already handle dragover/drop on
        // tabs themselves; this covers the gaps.
        this._setupContainerDragHandlers();

        // Click/focus input bar → exit direct mode
        this.inputTextArea.addEventListener('focus', () => {
            const activeTab = this.getActiveTab();
            if (activeTab?.directMode) {
                activeTab.directMode = false;
                // Coarse pointers: the keyboard is opening right now.
                // Toggle the UI but NEVER fit for it — frozen rows.
                this.updateDirectModeUI(activeTab, isCoarseViewport());
            }
            if (isCoarseViewport()) {
                // Only an input-focus transition may correct iOS WebKit's
                // focus-scroll. Generic page/terminal scrolling must never
                // be reset to the document origin.
                //
                // No fit, no PTY send, no scroll touch of any kind: the
                // keyboard overlays, the grid stays. (NEVER contract.)
                this.app.updateLayoutPosition?.(false, true);
            }
        });

        this.inputTextArea.addEventListener('blur', () => {
            if (isCoarseViewport()) {
                // Keyboard hiding: refresh the var only. No fit, no PTY
                // send, no scroll touch — frozen rows both ways.
                setTimeout(() => {
                    this.app.updateLayoutPosition?.(false);
                }, 150);
            }
        });

        // Trigger spam scroll on transition from empty to typed content
        this.inputTextArea.addEventListener('input', () => {
            const currentVal = this.inputTextArea.value;
            if (this.lastInputValue === '' && currentVal !== '') {
                const activeTab = this.getActiveTab();
                if (activeTab) {
                    this._spamScrollToBottom(activeTab);
                }
            }
            this.lastInputValue = currentVal;
            this.saveActiveDraft();
            this.adjustInputHeight();
            // Cursor-reset-on-type for prompt history lives in
            // _initPromptHistoryKeydown's own 'input' listener (kept
            // separate so it's independently unit-testable).
        });

        // Staged input send on Enter
        this.inputTextArea.addEventListener('keydown', (e) => {
            if (this.handleInputToggleShortcut?.(e)) return;

            // When input is empty, capture arrows, enter, escape and ctrl key
            // shortcuts to control PTY directly. The map lives in
            // _forwardKeyToPty, shared with the terminal-focused and mobile
            // paths; the emptiness gate is this caller's concern.
            const inputTab = this.getActiveTab();

            // Recall must run before empty-input PTY forwarding. During
            // a cycle, recalled multiline entries remain browsable.
            if (
                (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
                inputTab?.coder === 'pi' &&
                !inputTab.isDead &&
                !e.altKey &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.shiftKey &&
                !e.isComposing &&
                this.inputTextArea.selectionStart ===
                    this.inputTextArea.selectionEnd &&
                (this._piRecallCycleValid(inputTab) ||
                    (e.key === 'ArrowUp'
                        ? this._caretOnFirstLine()
                        : this._caretOnLastLine())) &&
                this._piRecallEligible(inputTab)
            ) {
                const recallDir = e.key === 'ArrowUp' ? 'older' : 'newer';
                if (this._piRecall?.pending) {
                    // Repeated keys keep their old order on a slow read.
                    this._resetPiRecall({ flush: true });
                } else if (this._piRecallCycleValid(inputTab)) {
                    if (this._cyclePiRecallCached(recallDir)) {
                        e.preventDefault();
                        return;
                    }
                    // Cache walk declined ('newer' at -1): fall through.
                } else if (
                    recallDir === 'older' && this.inputTextArea.value === ''
                ) {
                    // Empty input can defer the PTY arrow until the read.
                    e.preventDefault();
                    this._fetchPiRecall(recallDir, inputTab, e.key);
                    return;
                } else if (recallDir === 'older') {
                    // Do not suppress a native caret move we cannot replay.
                    this._fetchPiRecall(recallDir, inputTab, null);
                }
            }
            if (
                this.inputTextArea.value === '' &&
                inputTab?.coder !== 'pi-rpc' &&
                this._forwardKeyToPty(e, inputTab)
            ) {
                return;
            }

            // Plain Up/Down on a Pi RPC chat tab cycles the per-chat prompt
            // history (see _cycleChatHistory). Modifiers stay reserved
            // (Alt+Up/Down owns the global cross-cwd history); multiline
            // editing keeps the arrows — Up cycles only from the first line,
            // Down only from the last, and only with a collapsed selection.
            if (
                (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
                inputTab?.coder === 'pi-rpc' &&
                !e.altKey &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.shiftKey &&
                !e.isComposing &&
                this.inputTextArea.selectionStart ===
                    this.inputTextArea.selectionEnd &&
                (e.key === 'ArrowUp'
                    ? this._caretOnFirstLine()
                    : this._caretOnLastLine())
            ) {
                if (
                    this._cycleChatHistory(
                        e.key === 'ArrowUp' ? 'older' : 'newer',
                        inputTab,
                    )
                ) {
                    e.preventDefault();
                    return;
                }
            }

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendStagedInput();
            } else if (e.key === 'Escape') {
                if (this._handlePiRpcEscape(e)) return;
                // Return focus to terminal in Hybrid mode
                e.preventDefault();
                this.inputTextArea.blur();
                this.focusActiveTerminal();
            }
        });

        this.sendInputBtn.addEventListener('click', () => {
            this.sendStagedInput();
        });

        this.piThinkingBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._cyclePiThinking();
        });

        // Drag-and-drop and clipboard-paste attachments. Drop handler is on
        // .input-bar-container (not document) so tab-reorder drags on the
        // tabs strip don't conflict. Paste handler is on #input-textarea
        // so Cmd+V in the terminal pane still flows raw bytes to the PTY.
        this._initAttachmentDropZone();
        this._initAttachmentPasteHandler();
        this._initPromptHistoryKeydown();
        this._initBrandHud();

        // Global Ctrl+Shift+X -> send staged input. Fires regardless of
        // which element is focused (textarea, terminal, anywhere). The
        // chip only displays for pi, but the keybinding itself is
        // universally available since it's a quality-of-life shortcut.
        document.addEventListener('keydown', (e) => {
            if (
                e.ctrlKey &&
                e.shiftKey &&
                !e.altKey &&
                !e.metaKey &&
                (e.key === 'X' || e.key === 'x')
            ) {
                e.preventDefault();
                this.sendStagedInput();
                return;
            }
            // Mobile arrow-key capture fallback. On mobile the WebKit
            // soft keyboard sometimes yanks focus off the input bar
            // mid-type, so the per-textarea handler never fires. Forward
            // control keys at the document level whenever the staged
            // input is empty AND a tab is active. Desktop keeps the
            // original textarea-bound path; document-level capture would
            // steal arrow keys from terminal-internal tools (fzf, less,
            // etc.) on a real keyboard.
            if (!isCoarseViewport()) return;
            if (this.inputTextArea?.value !== '') return;
            if (this.inputBarContainer?.classList.contains('hidden')) return;
            const activeTab = this.getActiveTab();
            if (!activeTab || activeTab.isDead) return;
            // Skip if a modal is open - let the modal handler have the key.
            if (
                document.querySelector(
                    '.modal-overlay:not(.hidden), .md-modal-overlay:not(.hidden)',
                )
            )
                return;

            // Shared map (see _forwardKeyToPty). Two guards the old private
            // map made unnecessary: skip keys another handler already
            // consumed (the staged textarea's own listener — else Enter
            // double-fires), and skip keys typed into other editable
            // elements (find bar, tab renamer) now that Backspace/Tab are
            // in the map. Modifier combos stay excluded on mobile so
            // hardware keyboards on tablets keep their browser shortcuts.
            if (e.defaultPrevented) return;
            const t = e.target;
            if (
                t instanceof Element &&
                (t.closest('#tab-overflow-dropdown') ||
                    t.closest('#tab-overflow-btn') ||
                    t.closest('#sort-tabs-btn'))
            )
                return;
            if (
                t instanceof HTMLElement &&
                t !== this.inputTextArea &&
                (t.tagName === 'INPUT' ||
                    t.tagName === 'TEXTAREA' ||
                    t.isContentEditable)
            )
                return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            this._forwardKeyToPty(e, activeTab);
        });

        if (this.cancelInputBtn) {
            this.cancelInputBtn.addEventListener('click', () => {
                const activeTab = this.getActiveTab();
                if (activeTab?.coder === 'pi-rpc') {
                    this._interruptActivePiRpc();
                } else {
                    const cancelKey =
                        activeTab &&
                        ['pi', 'claude', 'opencode'].includes(activeTab.coder)
                            ? '\x1b'
                            : '\x03';
                    this.sendRawInput(cancelKey);
                }
                this.inputTextArea.focus({ preventScroll: true });
            });
        }

        if (this.copyInputBtn) {
            this.copyInputBtn.addEventListener('click', () => {
                this.sendRawInput('/copy\r');
                this.inputTextArea.focus({ preventScroll: true });
            });
        }

        if (this.ctrlTBtn) {
            this.ctrlTBtn.addEventListener('click', () => {
                const activeTab = this.getActiveTab();
                if (activeTab) {
                    this.sendRawInput('\x14');
                    this.focusActiveTerminal();
                }
            });
        }

        const closeAllBtn = document.getElementById('close-all-tabs-btn');
        const mobileCloseAllBtn = document.getElementById(
            'mobile-close-all-tabs-btn',
        );
        const handleCloseAll = () => {
            if (this.tabs.size === 0) return;
            if (
                confirm(
                    `Are you sure you want to close all ${this.tabs.size} active sessions?`,
                )
            ) {
                const keys = Array.from(this.tabs.keys());
                keys.forEach((paneId) => {
                    this.closeTab(paneId);
                });
                this.app.sessionsManager.loadSessions();
            }
        };
        closeAllBtn?.addEventListener('click', handleCloseAll);
        mobileCloseAllBtn?.addEventListener('click', handleCloseAll);

        const refreshConsoleBtn = document.getElementById(
            'refresh-console-btn',
        );
        const mobileRefreshConsoleBtn = document.getElementById(
            'mobile-refresh-console-btn',
        );
        const handleRefreshConsole = () => this.refreshConsole();
        refreshConsoleBtn?.addEventListener('click', handleRefreshConsole);
        mobileRefreshConsoleBtn?.addEventListener(
            'click',
            handleRefreshConsole,
        );

        // Direct Mode toggle
        this.directModeToggle.addEventListener('click', () => {
            const activeTab = this.getActiveTab();
            if (!activeTab || activeTab.coder === 'pi-rpc') return;

            activeTab.directMode = !activeTab.directMode;
            this.updateDirectModeUI(activeTab);

            if (activeTab.directMode) {
                this.focusActiveTerminal();
            } else {
                this.inputTextArea.focus({ preventScroll: true });
            }
        });

        // Window resize: on touch shells a height-only change is the
        // software keyboard, which must NEVER refit, resend, or touch
        // scroll (frozen rows — the keyboard overlays, the grid stays).
        // Width changes (rotation, drawer) and every fine-pointer
        // resize (including docked devtools) keep the immediate path.
        window.addEventListener('resize', () => this.handleWindowResize());

        const hostEl = document.getElementById('hostname-display');
        if (hostEl) {
            hostEl.addEventListener('click', (e) => {
                e.stopPropagation();
                // Clicking the hostname opens its tab-selector dropdown
                // — close the brand HUD first so the two popovers never
                // coexist. Without this, the HUD stays open while the
                // hostname dropdown shows underneath (visible clash).
                if (typeof this._closeSelfHudNow === 'function') {
                    this._closeSelfHudNow();
                }
                const dropdown = document.getElementById(
                    'hostname-tabs-dropdown',
                );
                if (dropdown) {
                    const isHidden = dropdown.classList.contains('hidden');
                    if (isHidden) {
                        this.renderHostnameTabsDropdown();
                        dropdown.classList.remove('hidden');
                    } else {
                        dropdown.classList.add('hidden');
                    }
                }
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this._handlePiRpcEscape(e);
            else this._handlePiRpcKeydown(e);
        });

        // Close dropups and dropdowns on clicking outside
        document.addEventListener('click', (e) => {
            const modelDropup = document.getElementById('model-presets-dropup');
            if (modelDropup && !modelDropup.classList.contains('hidden')) {
                if (
                    !e.target.closest('#model-presets-dropup') &&
                    !e.target.closest('.model-trigger-btn')
                ) {
                    modelDropup.classList.add('hidden');
                }
            }

            const qcDropup = document.getElementById('quick-commands-dropup');
            if (qcDropup && !qcDropup.classList.contains('hidden')) {
                if (
                    !e.target.closest('#quick-commands-dropup') &&
                    !e.target.closest('.model-trigger-btn')
                ) {
                    qcDropup.classList.add('hidden');
                }
            }

            const keysDropup = document.getElementById('keys-presets-dropup');
            if (keysDropup && !keysDropup.classList.contains('hidden')) {
                if (
                    !e.target.closest('#keys-presets-dropup') &&
                    !e.target.closest('.keys-trigger-btn')
                ) {
                    keysDropup.classList.add('hidden');
                }
            }

            const slashDropup = document.getElementById('slash-presets-dropup');
            if (slashDropup && !slashDropup.classList.contains('hidden')) {
                if (
                    !e.target.closest('#slash-presets-dropup') &&
                    !e.target.closest('.slash-trigger-btn')
                ) {
                    slashDropup.classList.add('hidden');
                }
            }

            const piModelDropup = document.getElementById(
                'pi-rpc-model-dropup',
            );
            if (piModelDropup && !piModelDropup.classList.contains('hidden')) {
                if (
                    !e.target.closest('#pi-rpc-model-dropup') &&
                    !e.target.closest('.pi-rpc-model-trigger')
                ) {
                    piModelDropup.classList.add('hidden');
                }
            }

            const piThinkingDropup = document.getElementById(
                'pi-rpc-thinking-dropup',
            );
            if (
                piThinkingDropup &&
                !piThinkingDropup.classList.contains('hidden')
            ) {
                if (
                    !e.target.closest('#pi-rpc-thinking-dropup') &&
                    !e.target.closest('.pi-rpc-thinking-trigger')
                ) {
                    piThinkingDropup.classList.add('hidden');
                }
            }

            const piSkillsDropup = document.getElementById(
                'pi-rpc-skills-dropup',
            );
            if (
                piSkillsDropup &&
                !piSkillsDropup.classList.contains('hidden')
            ) {
                if (
                    !e.target.closest('#pi-rpc-skills-dropup') &&
                    !e.target.closest('.pi-rpc-skills-trigger')
                ) {
                    piSkillsDropup.classList.add('hidden');
                }
            }

            const hostDropdown = document.getElementById(
                'hostname-tabs-dropdown',
            );
            if (hostDropdown && !hostDropdown.classList.contains('hidden')) {
                if (
                    !e.target.closest('#hostname-display') &&
                    !e.target.closest('#hostname-tabs-dropdown')
                ) {
                    hostDropdown.classList.add('hidden');
                }
            }

            const overflowDropdown = document.getElementById(
                'tab-overflow-dropdown',
            );
            if (
                overflowDropdown &&
                !overflowDropdown.classList.contains('hidden')
            ) {
                if (
                    !e.target.closest('#tab-overflow-btn') &&
                    !e.target.closest('#tab-overflow-dropdown')
                ) {
                    this._closeOverflowDropdown();
                }
            }
        });

        const sortTabsBtn = document.getElementById('sort-tabs-btn');
        if (sortTabsBtn) {
            sortTabsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.sortTabsByWorkspace();
            });
        }

        const overflowBtn = document.getElementById('tab-overflow-btn');
        if (overflowBtn) {
            overflowBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleOverflowDropdown();
            });
        }

        const handleOverflowEscape = (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            this._closeOverflowDropdown({ restoreFocus: true });
        };
        overflowBtn?.addEventListener('keydown', handleOverflowEscape);
        document
            .getElementById('tab-overflow-dropdown')
            ?.addEventListener('keydown', handleOverflowEscape);
        sortTabsBtn?.addEventListener('keydown', (e) => {
            const dropdown = document.getElementById('tab-overflow-dropdown');
            if (
                e.key === 'Escape' &&
                dropdown &&
                !dropdown.classList.contains('hidden')
            ) {
                handleOverflowEscape(e);
            }
        });

        // Passive scroll listener keeps the tab-list selector state in sync as the
        // user horizontally scrolls the strip. rAF-coalesced via a tiny
        // scheduler so we don't over-read.
        const strip = document.getElementById('tabs-container');
        if (strip) {
            let rafPending = false;
            const onScroll = () => {
                if (rafPending) return;
                rafPending = true;
                requestAnimationFrame(() => {
                    rafPending = false;
                    this.updateTabOverflow();
                });
            };
            strip.addEventListener('scroll', onScroll, { passive: true });
            // Recompute on resize to keep clipped-tab counts current.
            window.addEventListener('resize', onScroll, { passive: true });
        }
    }

    getActiveTab() {
        return this.tabs?.get(this.activePaneId);
    }

    // Browser chrome has a deliberately small, composable language:
    // Φ = all quiet, ϕ = a live terminal emitted output recently, and
    // the pre-existing leading ● remains exclusively for done/attention.
    // The header cursor mirrors only the live-output half of that state.
    updateDocumentTitle() {
        const state = getTerminalActivityState(this.tabs.values());
        document.title = formatTerminalActivityTitle(this.app.hostname, state);

        const indicator = document.getElementById(
            'terminal-activity-indicator',
        );
        if (indicator) {
            const hostnameKnown = Boolean(this.app.hostname);
            applyTerminalActivityIndicator(state.hasActivity, hostnameKnown);
        }

        // App owns favicon generation; guard keeps TabManager independently
        // usable in focused tests and lightweight embeds.
        if (this.app && typeof this.app.setTerminalActivity === 'function') {
            this.app.setTerminalActivity(state.hasActivity);
        }
    }

    focusActiveTerminal() {
        const activeTab = this.getActiveTab();
        if (activeTab?.term) {
            activeTab.term.focus();
        }
    }

    focusInputTextArea() {
        if (!this.inputTextArea) return;
        if (this.inputBarContainer?.classList.contains('hidden')) return;
        this.inputTextArea.focus({ preventScroll: true });
        const len = this.inputTextArea.value.length;
        this.inputTextArea.setSelectionRange(len, len);
    }

    toggleInputFocus() {
        if (!this.inputTextArea) return;
        if (this.inputBarContainer?.classList.contains('hidden')) return;
        if (document.activeElement === this.inputTextArea) {
            this.inputTextArea.blur();
            this.focusActiveTerminal();
        } else {
            this.focusInputTextArea();
        }
    }

    handleInputToggleShortcut(e) {
        if (e.defaultPrevented) return false;
        // Require Ctrl without Alt or Meta (Cmd).
        if (!e.ctrlKey || e.altKey || e.metaKey) return false;
        if (e.key !== '`' && e.key !== '~' && e.code !== 'Backquote') {
            return false;
        }

        e.preventDefault();
        this.toggleInputFocus();
        return true;
    }

    // ── Hot-v1 attach bootstrap, gap repair, screen checkpoints ──

    // The bounded delta ever allowed into the live terminal on attach or
    // reconnect. Checkpoint + delta ≤ 192 KiB first payload,
    // independent of session age.
    _paneData(tabInfo, data) {
        const pty = tabInfo.ws;
        // While the user reads a bounded older window, bytes continue to be
        // retained and sequenced by the backend but do not overwrite that view.
        // Jumping back to latest restores the saved live checkpoint and replays
        // the exact recording delta.
        if (pty && pty.mode === 'hot') {
            tabInfo._streamDecoder = pty.decoder;
            tabInfo.queuedSeq = pty.lastFrameEnd;
        }
        if (!tabInfo._historyBrowsing) {
            this.writeToTerminal(tabInfo, data);
            // Decoder-only frames have consumed source bytes but enqueue no
            // xterm write/callback. At quiescence they still own a frontier,
            // including the incomplete UTF-8 prefix retained by the decoder.
            // Checkpoints subtract that prefix exactly once; reconnect keeps it.
            if (pty?.mode === 'hot' && data.length === 0 &&
                !tabInfo.writePending && !tabInfo.writeBuffer?.length &&
                !tabInfo._bootstrapGate) {
                tabInfo.drainedSeq = tabInfo.queuedSeq;
                this._scheduleCheckpointUpload(tabInfo);
            }
        }
    }

    // Fetches a raw recording range from the server. Returns
    // { text, bytes, start, end, endCursor } or null after transient
    // failures. A permanent history failure (evicted prefix, expired
    // cursor, epoch change, missing group, oversized state) throws an
    // error flagged historyPermanent instead of retrying: callers end
    // their historical request or recover through a live checkpoint.
    //
    // Recovery reads exact source spans with their current resize metadata.
    // No negotiated cached prefix, hashes, or omitted response bodies.
    async _fetchRecordingRange(paneId, from, through, epoch, afterCursor) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const range = await this._fetchRecordingRangeOnce(paneId, from, through, epoch, undefined, afterCursor);
            if (range) return range;
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        }
        return null;
    }

    _historyPermanentError(message) {
        const error = new Error(message);
        error.historyPermanent = true;
        return error;
    }

    async _fetchRecordingRangeOnce(paneId, from, through, epoch, requestSignal, afterCursor) {
        try {
            // Bound each attempt. Failure never authorizes skipping bytes:
            // callers keep the stream held and reconnect for a fresh head.
            // Old Chromium lacks AbortSignal.timeout: degrade to an
            // unbounded fetch there (as before) rather than failing
            // every delta closed.
            const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10000) : undefined;
            const signal = requestSignal && timeout && typeof AbortSignal.any === 'function'
                ? AbortSignal.any([requestSignal, timeout]) : requestSignal || timeout;
            const validCursor = (v) => typeof v === 'string' && v.length <= 128 && /^v1\.\d+\.\d+\.\d+$/.test(v);
            const parts = [];
            const resizes = [];
            let cursor = from;
            let chained = afterCursor;
            let endCursor;
            while (cursor < through) {
                // Epoch scopes the read server-side too: a pane rebirth
                // between our attach and this fetch must 409, never serve
                // another lifetime's bytes into this stream.
                const epochParam = epoch !== undefined ? `&epoch=${epoch}` : '';
                const cursorParam = chained !== undefined ? `&after_event_cursor=${encodeURIComponent(chained)}` : '';
                const res = await fetch(
                    `/api/terminals/${encodeURIComponent(paneId)}/recording?from=${cursor}&through=${through}${epochParam}${cursorParam}`,
                    { cache: 'no-store', signal },
                );
                if (res.status === 204) return null;
                if ([400, 404, 409, 413].includes(res.status)) {
                    throw this._historyPermanentError(`Terminal history unavailable (${res.status}); the requested range was not skipped.`);
                }
                if (!res.ok) return null;
                const buf = new Uint8Array(await res.arrayBuffer());
                if (buf.byteLength < 4) return null;
                const jsonLen =
                    ((buf[0] << 24) |
                        (buf[1] << 16) |
                        (buf[2] << 8) |
                        buf[3]) >>>
                    0;
                if (4 + jsonLen > buf.byteLength) return null;
                let hdr;
                try {
                    hdr = JSON.parse(
                        new TextDecoder().decode(buf.subarray(4, 4 + jsonLen)),
                    );
                } catch (_e) {
                    return null;
                }
                // An advanced start means the floor moved past the request:
                // the prefix is evicted, not delayed. End the request. A
                // rewound start is malformed, not expired: it falls through
                // to the validation below and stays retryable.
                if (hdr && Number.isSafeInteger(hdr.start) && hdr.start > cursor) {
                    throw this._historyPermanentError('Terminal history expired; the requested prefix is no longer retained.');
                }
                // No skipped prefixes: validate bytes, lifetime and geometry
                // before admitting any part into the terminal.
                const data = buf.subarray(4 + jsonLen);
                const seq = n => Number.isSafeInteger(n) && n >= 0;
                if (!hdr || !seq(hdr.epoch) ||
                    (epoch !== undefined && hdr.epoch !== epoch) ||
                    !seq(hdr.start) || !seq(hdr.end) ||
                    hdr.start !== cursor || hdr.start > through ||
                    hdr.end <= hdr.start || hdr.end > through ||
                    data.byteLength !== hdr.end - hdr.start ||
                    (hdr.event_cursor !== undefined && !validCursor(hdr.event_cursor)) ||
                    (hdr.resizes !== undefined && (!Array.isArray(hdr.resizes) ||
                        hdr.resizes.some((m, i) => !Array.isArray(m) || m.length !== 3 ||
                            !seq(m[0]) || m[0] > hdr.end || (i > 0 && m[0] < hdr.resizes[i - 1][0]) || !Number.isInteger(m[1]) ||
                            !Number.isInteger(m[2]) || m[1] <= 0 || m[2] <= 0 || m[1] > 65535 || m[2] > 65535)))) return null;

                parts.push(data);
                resizes.push(...(hdr.resizes || []));
                if (hdr.end <= cursor) return null;
                cursor = hdr.end;
                if (hdr.event_cursor !== undefined) {
                    chained = hdr.event_cursor;
                    endCursor = hdr.event_cursor;
                }
            }
            if (cursor < through) return null;
            let byteLength = 0;
            for (const p of parts) byteLength += p.byteLength;
            // The normal single-response path already owns an exact view.
            // Assemble only when the server actually split the span.
            const bytes = parts.length === 1 ? parts[0] : new Uint8Array(byteLength);
            if (parts.length !== 1) {
                let off = 0;
                for (const p of parts) {
                    bytes.set(p, off);
                    off += p.byteLength;
                }
            }
            return {
                start: from,
                end: through,
                byteLength: bytes.byteLength,
                bytes,
                // Production replay consumes bytes through its stream decoder.
                // Keep the text convenience without decoding the span twice.
                get text() { return new TextDecoder().decode(bytes); },
                resizes,
                ...(endCursor === undefined ? {} : { endCursor }),
            };
        } catch (error) {
            // Permanent history failures propagate to the caller; anything
            // else (timeout, transport, abort, malformed envelope) stays a
            // transient null for the existing retry paths.
            if (error?.historyPermanent) throw error;
            return null;
        }
    }

    // Attaches the hot protocol's data/gap callbacks onto a pane's socket
    // options. Returns the PTYWebSocketOptions object for the ctor.
    // hostname_override is a display label only — it never rides a
    // socket option; the socket dials the real page origin.
    _hotOptions(tabInfo) {
        return {
            hot: true,
            onAttachHead: (info) => this._onAttachHead(tabInfo, info),
            onGap: (from, to) => this._onLiveGap(tabInfo, from, to),
        };
    }

    async _onAttachHead(tabInfo, info) {
        const pty = tabInfo.ws;
        if (pty?.mode !== 'hot') return;
        const prevEpoch = tabInfo.paneEpoch;
        const samePane = prevEpoch !== undefined && prevEpoch === info.epoch;
        if (!samePane || info.ckpt?.bytes) tabInfo._serverStateAvailable = Boolean(info.ckpt?.bytes);
        if (!samePane) {
            this._cancelHistoryRequest(tabInfo);
            // A different pane lifetime owns a different byte stream.
            pty.hold?.();
            tabInfo._bootstrapGen = (tabInfo._bootstrapGen ?? 0) + 1;
        }
        if (!samePane && tabInfo._termOpened) {
            // Finish admitted old-epoch writes before resetting the screen.
            // Cancel their owners before awaiting the parser callbacks.
            tabInfo.paneEpoch = info.epoch;
            const drain = this._drainSettled(tabInfo);
            tabInfo._bootstrapGate = drain;
            await drain;
            if (tabInfo.ws !== pty || tabInfo.paneEpoch !== info.epoch || tabInfo.finalizing) return;
            if (tabInfo._bootstrapGate === drain) tabInfo._bootstrapGate = null;
            this._clearHistoryState(tabInfo);
        }
        if (!samePane || !tabInfo._termOpened) tabInfo._historyOmitted = Boolean(info.ckpt?.through);

        if (!tabInfo._termOpened) {
            tabInfo._streamDecoder = pty.decoder;
            // Fresh tab: write the checkpoint synchronously, open the
            // terminal, and release held live frames so first paint is
            // not gated on the network. The bounded tail delta is
            // fetched in the background and appended when it arrives.
            if (info.ckpt) {
                try {
                    tabInfo.term.resize(info.ckpt.cols, info.ckpt.rows);
                } catch (_e) {
                    /* default size; post-open fit corrects it */
                }
                this._writeAttachCheckpoint(tabInfo, pty, info.ckpt);
            }
            tabInfo.paneEpoch = info.epoch;
            tabInfo.paneOldest = info.oldest;
            // The attach head is a source frontier, not a client parser
            // frontier. Only the checkpoint is already represented locally;
            // bootstrap ranges advance these watermarks after xterm parses them.
            let from = info.ckpt ? info.ckpt.through : info.oldest;
            if (!info.ckpt && isCoarseViewport() && info.replayFrom !== undefined) {
                from = info.replayFrom;
            }
            tabInfo._historyOmitted = Boolean(info.ckpt?.through) || from > info.oldest;
            tabInfo._historyWindowStart = info.ckpt ? info.head : from;
            tabInfo._historyWindowEnd = info.head;
            tabInfo.queuedSeq = from;
            tabInfo.drainedSeq = from;
            tabInfo._forceStateRefresh = false;
            this._openTermAndViewport(tabInfo);
            this._bootstrappedRelease(tabInfo, pty, from, info.head, info.ckpt?.eventCursor);
            return;
        }

        if (samePane) {
            // Same-epoch replay belongs to the terminal, not its old socket.
            // Wait for successor gates too (bootstrap can hand off to paging).
            while (tabInfo._bootstrapGate) {
                const pendingBootstrap = tabInfo._bootstrapGate;
                await pendingBootstrap.catch(() => {});
                if (
                    tabInfo.isDead ||
                    tabInfo.ws !== pty ||
                    tabInfo.paneEpoch !== info.epoch
                ) return;
                if (tabInfo._bootstrapGate === pendingBootstrap) break;
            }
            if (tabInfo._forceStateRefresh) {
                tabInfo._historyBrowsing = false;
                tabInfo._historyLiveState = null;
            }
            if (tabInfo._historyBrowsing) {
                // Freeze this historical view. The new head is a source
                // frontier; latest restoration replays the saved live state.
                tabInfo.paneOldest = info.oldest;
                // Re-measure the actual panel, not the saved book's grid.
                // A hidden pane must not steal geometry from another client.
                this._queuePanelFit(tabInfo, { forceResize: true });
                pty.release();
                this._updateHistoryButton(tabInfo);
                return;
            }
            // Finish old-socket writes before choosing the resume point.
            // Fetching from a stale drainedSeq while those writes are still
            // queued would append the same bytes twice. Hold gap repair too,
            // so it cannot race ahead of the later recording bootstrap.
            if (tabInfo.writePending || tabInfo.writeBuffer?.length) {
                const drainGate = this._drainSettled(tabInfo);
                tabInfo._bootstrapGen = (tabInfo._bootstrapGen ?? 0) + 1;
                tabInfo._bootstrapGate = drainGate;
                await drainGate;
                if (
                    tabInfo.isDead ||
                    tabInfo.ws !== pty ||
                    tabInfo._bootstrapGate !== drainGate
                ) {
                    if (tabInfo._bootstrapGate === drainGate) {
                        tabInfo._bootstrapGate = null;
                    }
                    return;
                }
                // The queue is now actually parsed. Its gate suppressed
                // automatic advancement; publish that proven frontier here.
                tabInfo.drainedSeq = tabInfo.queuedSeq ?? tabInfo.drainedSeq;
                tabInfo._bootstrapGate = null;
            }
            const visible = tabInfo.term.buffer?.active;
            const readingLocalHistory = !tabInfo._forceStateRefresh && visible?.type === 'normal' && visible.viewportY < visible.baseY;
            if (info.ckpt?.bytes && !readingLocalHistory) {
                if (info.head < (tabInfo.drainedSeq ?? 0)) {
                    try { pty.ws?.close(); } catch (_e) {}
                    return;
                }
                // Current state is authoritative on reconnect too. Retaining a
                // damaged local parser and repainting it just repaints garbage.
                // Older books remain in the archive; a reader's view stays put.
                this._clearHistoryAnchors(tabInfo);
                resetTerminalState(tabInfo.term);
                tabInfo.term.resize(info.ckpt.cols, info.ckpt.rows);
                pty.decoder = new TextDecoder('utf-8');
                tabInfo._streamDecoder = pty.decoder;
                this._writeAttachCheckpoint(tabInfo, pty, info.ckpt);
                tabInfo._forceStateRefresh = false;
                tabInfo.paneOldest = info.oldest;
                tabInfo._historyWindowStart = info.ckpt.through;
                tabInfo._historyWindowEnd = info.head;
                tabInfo._historyOmitted = info.ckpt.through > info.oldest;
                tabInfo.queuedSeq = info.ckpt.through;
                tabInfo.drainedSeq = info.ckpt.through;
                this._bootstrappedRelease(tabInfo, pty, info.ckpt.through, info.head, info.ckpt.eventCursor);
                return;
            }
            // Legacy or a visible local history book: resume without replacing
            // the reader's view, then refresh the live process at panel geometry.
            const from = tabInfo.drainedSeq ?? info.head;
            // A parsed batch can end with an incomplete UTF-8 prefix in
            // the decoder, even though no glyph reached xterm yet. Keep
            // that prefix on a same-pane, fully-drained reconnect. Never
            // reuse decoder state beyond the resume frontier or across
            // a truncated recording / different pane lifetime.
            if (
                tabInfo._streamDecoder &&
                from === tabInfo.queuedSeq &&
                from >= info.oldest &&
                info.head >= from
            ) {
                pty.decoder = tabInfo._streamDecoder;
            }
            tabInfo._streamDecoder = pty.decoder;
            tabInfo.paneEpoch = info.epoch;
            tabInfo.paneOldest = info.oldest;
            if (from >= info.oldest && from <= info.head) {
                this._bootstrappedRelease(tabInfo, pty, from, info.head);
            } else if (from < info.oldest) {
                // The resume frontier is evicted. Bootstrap anyway: the
                // delta fetch reports the expired prefix and the bootstrap
                // recovers through the live checkpoint. Closing here would
                // reconnect into the same evicted frontier forever.
                this._bootstrappedRelease(tabInfo, pty, from, info.head);
            } else {
                // A resize is not a repair for missing source bytes. Never
                // release a socket across an unfilled or regressed frontier.
                try { pty.ws?.close(); } catch (_e) {}
            }
            return;
        }

        // Different pane lifetime under the same id: fresh start. The
        // existing buffer belongs to a dead epoch — reset it.
        pty.decoder = new TextDecoder('utf-8');
        tabInfo._streamDecoder = pty.decoder;
        try {
            resetTerminalState(tabInfo.term);
        } catch (e) {
            console.error('[term] reset on epoch change failed:', e);
        }
        if (tabInfo._pendingResetBanner) {
            this.writeToTerminal(tabInfo, tabInfo._pendingResetBanner);
            tabInfo._pendingResetBanner = null;
        }
        if (info.ckpt) {
            // A checkpoint's cursor coordinates and wrapping belong to its
            // recorded grid, not the previous pane lifetime's fitted grid.
            tabInfo.term.resize(info.ckpt.cols, info.ckpt.rows);
            this._writeAttachCheckpoint(tabInfo, pty, info.ckpt);
        }
        tabInfo.paneEpoch = info.epoch;
        tabInfo.paneOldest = info.oldest;
        let from = info.ckpt ? info.ckpt.through : info.oldest;
        if (!info.ckpt && isCoarseViewport() && info.replayFrom !== undefined) {
            from = info.replayFrom;
        }
        tabInfo._historyOmitted = Boolean(info.ckpt?.through) || from > info.oldest;
        tabInfo._historyWindowStart = info.ckpt ? info.head : from;
        tabInfo._historyWindowEnd = info.head;
        tabInfo.queuedSeq = from;
        tabInfo.drainedSeq = from;
        tabInfo._forceStateRefresh = false;
        this._bootstrappedRelease(tabInfo, pty, from, info.head, info.ckpt?.eventCursor);
    }

    _writeAttachCheckpoint(tabInfo, pty, checkpoint) {
        // Keep any unfinished UTF-8 suffix in the same decoder that will
        // consume live bytes. Merely receiving (but ignoring) a same-pane
        // checkpoint must not change that decoder's retained prefix.
        const text = checkpoint.bytes && typeof pty.decodeOutput === 'function'
            ? pty.decodeOutput(checkpoint.bytes)
            : checkpoint.ansi;
        this.writeToTerminal(tabInfo, text);
    }

    // Fetches the bounded attach/reconnect delta in the background and
    // appends it to the live terminal after the network completes.
    // Aborted silently when the page is gone or the pane is dead; bounded
    // by HOT_DELTA_LIMIT_BYTES so we never silently flood scrollback.
    // Ordered bootstrap: finish parsing, restore live geometry, send its
    // resize, then release live delivery. Historical sizes must never leak
    // into newly delivered live bytes. The release targets the attach-time socket only: a
    // reconnect swaps tabInfo.ws, and releasing a stale socket would flush
    // its orphaned frames into the new stream.
    _bootstrappedRelease(tabInfo, pty, from, head, eventCursor) {
        // Generation counters serialize overlapping bootstraps on one
        // socket (a second head while a delta fetch is in flight): only
        // the newest generation writes or releases; older ones dissolve.
        // Production sends one head per connection, so this is purely
        // defensive — but without it a duplicate head would append a
        // stale delta below newer bytes.
        const gen = (tabInfo._bootstrapGen ?? 0) + 1;
        tabInfo._bootstrapGen = gen;
        tabInfo._gapInFlight = false;
        // One barrier owns replay and sizing. Release is idempotent and
        // happens only after the parser and current geometry are settled.
        const releaseOnce = () => {
            if (tabInfo._bootstrapGate === boot) {
                tabInfo._bootstrapGate = null;
                if (tabInfo.ws === pty) {
                    try {
                        pty.release();
                    } catch (_e) {}
                    if (tabInfo._pendingPanelFit) this._queuePanelFit(tabInfo);
                }
            }
        };
        const boot = (async () => {
            let complete = false;
            try {
                complete = await this._bootstrapDelta(tabInfo, from, head, gen, releaseOnce, eventCursor);
            } catch (error) {
                console.warn('[term] bootstrap failed:', error);
            }
            if (complete) releaseOnce();
            else if (tabInfo.ws === pty && tabInfo._bootstrapGen === gen) {
                // Never release held live frames across an unfilled interval.
                tabInfo._bootstrapGate = null;
                try { pty.ws?.close(); } catch (_e) {}
            }
        })();
        tabInfo._bootstrapGate = boot;
        this._trackBootstrap(tabInfo, boot);
    }

    // Tracked bootstrap: prod never awaits these, so settled entries prune
    // themselves (no per-reconnect slot leak) and rejections are swallowed
    // here — a failed delta only means a slower open, never a crash.
    // Tests use the live array as a flush barrier; Promise.all snapshots
    // at call time, so pruning after settle is invisible to them.
    _trackBootstrap(tabInfo, promise) {
        tabInfo._pendingBootstraps = tabInfo._pendingBootstraps || [];
        tabInfo._pendingBootstraps.push(promise);
        promise
            .catch(() => {})
            .finally(() => {
                const arr = tabInfo._pendingBootstraps;
                if (!arr) return;
                const i = arr.indexOf(promise);
                if (i >= 0) arr.splice(i, 1);
            });
    }

    _clearHistoryAnchors(tabInfo) {
        for (const anchor of tabInfo._historyAnchors || []) anchor.marker.dispose();
        tabInfo._historyAnchors = [];
    }

    _clearHistoryState(tabInfo) {
        this._cancelHistoryRequest(tabInfo);
        this._clearHistoryAnchors(tabInfo);
        tabInfo._historyBrowsing = false;
        tabInfo._historyLiveState = null;
        tabInfo._historyWindowStart = undefined;
        tabInfo._historyWindowEnd = undefined;
        tabInfo._historyLoading = false;
        tabInfo._historyParsing = false;
        tabInfo._gapInFlight = false;
    }

    _recordHistoryAnchor(tabInfo, through) {
        const buffer = tabInfo.term?._core?._bufferService?.buffers?.normal;
        if (!buffer?.addMarker || tabInfo.term.buffer.active.type !== 'normal') return;
        const anchors = (tabInfo._historyAnchors || []).filter(a => !a.marker.isDisposed);
        anchors.push({ through, marker: buffer.addMarker(buffer.ybase + buffer.y) });
        tabInfo._historyAnchors = anchors;
    }

    _oldestHistoryAnchor(tabInfo) {
        return (tabInfo._historyAnchors || []).find(a => !a.marker.isDisposed);
    }

    _captureLiveHistoryState(tabInfo) {
        const term = tabInfo.term;
        const pty = tabInfo.ws;
        if (!term || !pty) return null;
        const encoding = term._core?.mouseStateService?.activeEncoding;
        const mouseMode = encoding === 'SGR' ? '\x1b[?1006h'
            : encoding === 'SGR_PIXELS' ? '\x1b[?1016h' : '';
        const ansi = tabInfo.serializeAddon ? mouseMode + terminalSnapshot(term, tabInfo.serializeAddon, {
            scrollback: isCoarseViewport() ? PHONE_CHECKPOINT_ROWS : LIVE_SCROLLBACK_ROWS,
        }) : '';
        const queued = tabInfo.queuedSeq ?? tabInfo.drainedSeq ?? 0;
        const drained = tabInfo.drainedSeq ?? queued;
        return {
            ansi,
            cols: term.cols,
            rows: term.rows,
            through: tabInfo.serializeAddon
                ? Math.max(0, drained - (pty.pendingUTF8Bytes ?? 0))
                : (tabInfo.paneOldest ?? 0),
            head: queued,
            epoch: tabInfo.paneEpoch,
        };
    }

    async _loadColdHistory(tabInfo) {
        if (tabInfo._serverStateAvailable) {
            if ((!tabInfo._historyBrowsing && tabInfo.term?.buffer?.active?.type !== 'normal') || !tabInfo._historyOmitted || tabInfo.ws?.mode !== 'hot') return;
            return this._loadStateHistory(tabInfo);
        }
        const pty = tabInfo.ws;
        // Alternate-screen scroll belongs to the live application, not
        // xterm scrollback. Never reset a TUI in response to its wheel input.
        if (tabInfo.term?.buffer?.active?.type !== 'normal' ||
            !tabInfo._historyOmitted || tabInfo._historyLoading || tabInfo.finalizing || pty?.mode !== 'hot') return;
        tabInfo._historyLoading = true;
        this._updateHistoryButton(tabInfo);
        let finishGate;
        let gate;
        const epoch = tabInfo.paneEpoch;
        const current = () => !tabInfo.finalizing && tabInfo.paneEpoch === epoch;
        let reset = false;
        try {
            if (tabInfo._bootstrapGate) await tabInfo._bootstrapGate;
            if (!current()) return;
            pty.hold();
            gate = new Promise(resolve => { finishGate = resolve; });
            tabInfo._bootstrapGate = gate;
            await this._drainSettled(tabInfo);
            if (!current()) return;
            const liveState = tabInfo._historyLiveState;
            const windowHead = liveState?.head ?? tabInfo.drainedSeq;
            const oldest = tabInfo.paneOldest ?? 0;
            const previousEnd = tabInfo._historyWindowEnd ?? windowHead;
            const anchor = this._oldestHistoryAnchor(tabInfo);
            // End inside the previous page's retained rows, not before an
            // assumed byte budget. This overlap works for short lines too.
            const wholeHistoryFits = !tabInfo._historyBrowsing &&
                windowHead - oldest <= HISTORY_WINDOW_BYTES &&
                (tabInfo.term.buffer.active.baseY ?? 0) < LIVE_SCROLLBACK_ROWS;
            const end = wholeHistoryFits ? windowHead
                : anchor && anchor.through > oldest && anchor.through < previousEnd
                    ? anchor.through
                    : tabInfo._historyBrowsing
                        ? Math.max(oldest, previousEnd - HISTORY_MIN_STEP_BYTES)
                        : windowHead;
            const from = Math.max(oldest, end - HISTORY_WINDOW_BYTES);
            if (!liveState) {
                tabInfo._historyLiveState = this._captureLiveHistoryState(tabInfo);
                if (!tabInfo._historyLiveState) {
                    throw new Error('cannot page history without a live-state checkpoint');
                }
            }
            const range = await this._fetchRecordingRange(tabInfo.paneId, from, end, epoch);
            if (!current()) return;
            if (!range) throw new Error('terminal history temporarily unavailable');
            tabInfo._historyParsing = true;
            this._clearHistoryAnchors(tabInfo);
            resetTerminalState(tabInfo.term);
            reset = true;
            pty.decoder = new TextDecoder('utf-8');
            tabInfo._streamDecoder = pty.decoder;
            tabInfo.queuedSeq = from;
            tabInfo.drainedSeq = from;
            tabInfo.userFollowBottom = false;
            if (!await this._parseRecordingRange(tabInfo, range, current, undefined, pty)) return;
            tabInfo._historyWindowStart = from;
            tabInfo._historyWindowEnd = range.end;
            // This flag means older bytes remain before the visible window.
            // Newer bytes live behind the explicit jump-to-latest action.
            const retainedRows = tabInfo.term.buffer.active?.baseY ?? 0;
            tabInfo._historyOmitted = from > oldest ||
                (from === oldest && retainedRows >= LIVE_SCROLLBACK_ROWS);
            if (range.end < windowHead || tabInfo._historyOmitted) {
                tabInfo._historyBrowsing = true;
                tabInfo.queuedSeq = pty.lastFrameEnd ?? windowHead;
                tabInfo.drainedSeq = tabInfo._historyLiveState?.through ?? windowHead;
                tabInfo.term.scrollToTop();
            } else {
                tabInfo._historyBrowsing = false;
                tabInfo._historyLiveState = null;
                tabInfo.queuedSeq = range.end;
                tabInfo.drainedSeq = range.end;
                // Loading older history still shows the oldest row when the
                // entire archive fits. Live writes preserve that view.
                tabInfo.term.scrollToTop();
            }
        } catch (error) {
            console.warn('[term] cold history:', error);
            if (!current()) return;
            if (reset) {
                // The view was already cleared, so the pane needs a consistent
                // frontier before live frames resume. Take the live state: a
                // re-attach for a missing book only repeats the repaint.
                const healed = await this._recoverBootstrapFromLiveState(tabInfo, pty, () => current() && tabInfo.ws === pty);
                // Never stay in browsing mode after a failure: the next
                // wheel event would run the same miss again.
                tabInfo._historyBrowsing = false;
                if (healed === null) {
                    try { pty.ws.close(); } catch (_e) {}
                }
            } else if (error?.historyPermanent) {
                // Nothing was repainted, so re-attaching costs no replay here.
                // The fresh attach head carries the current retention floor.
                try { pty.ws.close(); } catch (_e) {}
            }
        } finally {
            if (current()) {
                tabInfo._historyLoading = false;
                tabInfo._historyParsing = false;
                this._updateHistoryButton(tabInfo);
            }
            if (tabInfo._bootstrapGate === gate) tabInfo._bootstrapGate = null;
            finishGate?.();
            if (current() && tabInfo.ws === pty) pty.release();
        }
    }

    async _restoreLatestHistory(tabInfo) {
        if (tabInfo._serverStateAvailable) return this._loadStateHistory(tabInfo, true);
        const pty = tabInfo.ws;
        const saved = tabInfo._historyLiveState;
        if (!tabInfo._historyBrowsing || !saved || saved.epoch !== tabInfo.paneEpoch || tabInfo._historyLoading ||
            tabInfo.finalizing || pty?.mode !== 'hot') return;
        tabInfo._historyLoading = true;
        this._updateHistoryButton(tabInfo);
        let finishGate;
        let gate;
        const epoch = tabInfo.paneEpoch;
        const current = () => !tabInfo.finalizing && tabInfo.paneEpoch === epoch;
        try {
            pty.hold();
            gate = new Promise(resolve => { finishGate = resolve; });
            tabInfo._bootstrapGate = gate;
            const head = Math.max(saved.head, pty.lastFrameEnd ?? 0);
            this._clearHistoryAnchors(tabInfo);
            resetTerminalState(tabInfo.term);
            tabInfo.term.resize(saved.cols, saved.rows);
            pty.decoder = new TextDecoder('utf-8');
            tabInfo._streamDecoder = pty.decoder;
            tabInfo._historyParsing = true;
            tabInfo.queuedSeq = saved.through;
            tabInfo.drainedSeq = saved.through;
            this.writeToTerminal(tabInfo, saved.ansi);
            await this._drainSettled(tabInfo);
            for (let from = saved.through; from < head;) {
                const end = Math.min(head, from + MAX_DELTA_BYTES);
                let range;
                try {
                    range = await this._fetchRecordingRange(
                        tabInfo.paneId,
                        from,
                        end,
                        epoch,
                    );
                } catch (error) {
                    // The saved live frontier is evicted. Restore through
                    // the authoritative live state instead of replaying it.
                    if (error?.historyPermanent && current()) return this._loadStateHistory(tabInfo, true);
                    throw error;
                }
                if (!current()) return;
                if (!range) throw new Error('latest terminal output temporarily unavailable');
                if (!await this._parseRecordingRange(tabInfo, range, current, undefined, pty)) return;
                from = end;
                tabInfo.queuedSeq = end;
                tabInfo.drainedSeq = end;
            }
            const oldest = tabInfo.paneOldest ?? 0;
            this._fitVisibleTerminal(tabInfo);
            if (this._terminalPanelVisible?.(tabInfo) !== false && tabInfo.ws === pty && typeof pty.sendResize === 'function' &&
                pty.sendResize(tabInfo.term.cols, tabInfo.term.rows) !== false) tabInfo._sizedWs = pty;
            tabInfo._historyWindowStart = this._oldestHistoryAnchor(tabInfo)?.through ?? head;
            tabInfo._historyWindowEnd = head;
            tabInfo._historyOmitted = saved.through > oldest || tabInfo._historyWindowStart > oldest;
            tabInfo._historyBrowsing = false;
            tabInfo._historyLiveState = null;
            tabInfo.userFollowBottom = true;
            tabInfo.term.scrollToBottom();
        } catch (error) {
            console.warn('[term] restore latest history:', error);
            if (!current()) return;
            // The saved frontier is evicted: the replay cannot succeed, and it
            // never will for this saved view. Closing here re-attached, the
            // re-attach repainted the whole pane and kept _historyBrowsing
            // set (only a new epoch clears it), so the next wheel event ran
            // this again and the reader watched the history replay on repeat.
            // Take the live state instead, and never stay in browsing mode.
            const healed = await this._recoverBootstrapFromLiveState(tabInfo, pty, () => current() && tabInfo.ws === pty);
            tabInfo._historyBrowsing = false;
            if (healed === null) {
                try { pty.ws?.close(); } catch (_e) {}
            }
        } finally {
            if (current()) {
                tabInfo._historyLoading = false;
                tabInfo._historyParsing = false;
                this._updateHistoryButton(tabInfo);
            }
            if (tabInfo._bootstrapGate === gate) tabInfo._bootstrapGate = null;
            finishGate?.();
            if (current() && tabInfo.ws === pty) {
                pty.release();
                if (!tabInfo._historyBrowsing && tabInfo._pendingPanelFit) this._queuePanelFit(tabInfo);
            }
        }
    }

    async _parseRecordingRange(tabInfo, range, current, deliver, decodeSocket = tabInfo.ws) {
        // Resize only after preceding bytes reach the parser. Applying
        // geometry to a queued write interprets that write in the new grid.
        await this._drainSettled(tabInfo);
        if (!current()) return false;
        const markers = (range.resizes || []).slice().sort((a, b) => a[0] - b[0]);
        let prior;
        const changes = [];
        for (const marker of markers) {
            if (marker[0] < range.start) prior = marker;
            else if (marker[0] <= range.end) changes.push(marker);
        }
        if (prior) changes.unshift(prior);
        let cursor = range.start;
        const capture = !deliver && (!tabInfo._historyBrowsing || tabInfo._historyParsing) &&
            Boolean(tabInfo.term?._core?._bufferService?.buffers?.normal?.addMarker);
        const parse = async (end) => {
            while (cursor < end) {
                const stop = capture ? Math.min(end, cursor + HISTORY_ANCHOR_BYTES) : end;
                const bytes = range.bytes.subarray(cursor - range.start, stop - range.start);
                if (deliver) {
                    // The socket alone owns decoding and gap sequencing.
                    deliver(bytes);
                } else {
                    const text = decodeSocket?.decodeOutput ? decodeSocket.decodeOutput(bytes)
                        : decodeSocket?.decoder ? decodeSocket.decoder.decode(bytes, { stream: true })
                        : new TextDecoder().decode(bytes);
                    this.writeToTerminal(tabInfo, text);
                }
                await this._drainSettled(tabInfo);
                if (!current()) return false;
                if (capture) this._recordHistoryAnchor(tabInfo, stop - (decodeSocket?.pendingUTF8Bytes ?? 0));
                cursor = stop;
            }
            return true;
        };
        for (const [at, cols, rows] of changes) {
            if (!await parse(Math.max(range.start, at))) return false;
            if (!current()) return false;
            if (tabInfo.term.cols !== cols || tabInfo.term.rows !== rows) tabInfo.term.resize(cols, rows);
        }
        return parse(range.end);
    }

    // Reattaches a bootstrap through an authoritative live checkpoint when
    // its span crossed the retention floor. Returns the adopted frontier or
    // null when recovery is impossible (the caller fails its bootstrap).
    async _recoverBootstrapFromLiveState(tabInfo, ws, current) {
        const epoch = tabInfo.paneEpoch;
        let state = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                state = await this._fetchTerminalState(tabInfo.paneId, epoch, 'latest');
            } catch (error) {
                if (error?.historyPermanent) return null;
                state = null;
            }
            if (state) break;
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
        if (!state || !current()) return null;
        const pty = tabInfo.ws;
        this._clearHistoryAnchors(tabInfo);
        resetTerminalState(tabInfo.term);
        tabInfo.term.resize(state.cols, state.rows);
        pty.decoder = new TextDecoder('utf-8');
        tabInfo._streamDecoder = pty.decoder;
        this._writeAttachCheckpoint(tabInfo, pty, state);
        tabInfo.paneOldest = state.oldest;
        tabInfo._historyLiveState = null;
        const frontier = state.through;
        tabInfo.queuedSeq = frontier;
        tabInfo.drainedSeq = frontier;
        if (typeof pty.adoptState === 'function') pty.adoptState(frontier);
        return frontier;
    }

    async _bootstrapDelta(tabInfo, from, head, expectGen, onReady, eventCursor) {
        const ws = tabInfo.ws;
        const epoch = tabInfo.paneEpoch;
        let admitted = false;
        const current = () => !tabInfo.finalizing && tabInfo.paneEpoch === epoch &&
            (tabInfo.ws === ws || admitted) &&
            (expectGen === undefined || tabInfo._bootstrapGen === expectGen);
        if (!current()) return false;
        // Even a zero-delta resume must finish its checkpoint write before
        // fitting the live viewport and synchronizing backend dimensions.
        if (from === head || tabInfo.writePending || tabInfo.writeBuffer?.length) {
            await this._drainSettled(tabInfo);
            if (!current()) return false;
        }
        let cursor = from;
        let target = head;
        let chained = eventCursor;
        while (cursor < target) {
            const end = Math.min(target, cursor + MAX_DELTA_BYTES);
            let d;
            try {
                d = await this._fetchRecordingRange(tabInfo.paneId, cursor, end, tabInfo.paneEpoch, chained);
            } catch (error) {
                if (!error?.historyPermanent) throw error;
                if (!current()) return false;
                // The span crossed the retention floor. Adopt the live
                // checkpoint and resume from its frontier instead of
                // replaying evicted bytes.
                const frontier = await this._recoverBootstrapFromLiveState(tabInfo, ws, current);
                if (frontier === null) return false;
                admitted = true;
                cursor = frontier;
                target = Math.max(target, frontier);
                chained = undefined;
                continue;
            }
            if (!current()) return false;
            if (!d || d.start !== cursor || d.end !== end || d.byteLength !== end - cursor ||
                (d.bytes && d.bytes.byteLength !== d.byteLength)) return false;
            admitted = true;
            if (d.endCursor !== undefined) chained = d.endCursor;
            if (d.bytes) {
                if (!await this._parseRecordingRange(tabInfo, d, current, undefined, ws)) return false;
            } else {
                this.writeToTerminal(tabInfo, d.text);
                await this._drainSettled(tabInfo);
            }
            if (!current()) return false;
            if (ws?.mode === 'hot' && ws.decoder) tabInfo._streamDecoder = ws.decoder;
            if ((tabInfo.queuedSeq ?? 0) <= end) {
                tabInfo.queuedSeq = end;
                tabInfo.drainedSeq = end;
            }
            cursor = end;
        }
        // Restore visible panel geometry; hidden parsers keep the recorded
        // grid until activation provides measurable panel dimensions.
        this._fitVisibleTerminal(tabInfo);
        // The fit restores geometry, not necessarily the viewport's derived
        // scroll position; re-derive it now that the replay is painted.
        this._refreshTerminalScreen(tabInfo);
        // Every attachment needs a real resize, including equal-size and
        // zero-delta reconnects. Only the current socket may own this sizing.
        if (this._terminalPanelVisible?.(tabInfo) !== false && tabInfo.ws === ws && typeof ws?.sendResize === 'function' &&
            ws.sendResize(tabInfo.term.cols, tabInfo.term.rows) !== false) {
            tabInfo._sizedWs = ws;
        } else {
            tabInfo._pendingPanelFit = true;
            tabInfo._pendingForceResize = true;
        }
        onReady?.();
        // A quiet raw attach must also leave a checkpoint; otherwise every
        // refresh repeats the whole prefix until the backend emits again.
        this._scheduleCheckpointUpload(tabInfo);
        return true;
    }

    async _onLiveGap(tabInfo, from, to) {
        const pty = tabInfo.ws;
        if (pty?.mode !== 'hot') return;
        // Order with an in-flight bootstrap: the delta must enqueue first,
        // or the patch (newer bytes) lands below it. Stale when the socket
        // swapped mid-fetch: verify identity before touching watermarks.
        // Superseded when a newer bootstrap generation began mid-fetch:
        // the new head owns the stream now, so this patch dissolves.
        while (tabInfo._bootstrapGate) {
            const gate = tabInfo._bootstrapGate;
            await gate.catch(() => {});
            if (tabInfo.isDead || tabInfo.ws !== pty) return;
            // A parse-drain gate can hand off to a recording bootstrap.
            // Wait for the successor too, rather than patch ahead of it.
            if (tabInfo._bootstrapGate === gate) break;
        }
        // The wait may have outlived the hole: a flush-stop re-fire (or
        // another patch) can advance past `from` while this event waits.
        // liveSeq only moves forward, so from < liveSeq means this range
        // is covered — the remainder, if any, re-fires on its own.
        if (from < pty.liveSeq) return;
        const bootGen = tabInfo._bootstrapGen;
        // One gap fetch per tab at a time. Concurrent onGap events
        // describe overlapping ranges of the same hole; letting two
        // patches interleave would deliver stale bytes at the new head
        // (duplication plus loss). The in-flight patch's flush re-fires
        // onGap if a gap remains, so dropping concurrent events converges
        // instead of stalling.
        if (tabInfo._gapInFlight) return;
        tabInfo._gapInFlight = true;
        pty.hold?.();
        const current = () => !tabInfo.finalizing && tabInfo.ws === pty && tabInfo._bootstrapGen === bootGen;
        let recovered = false;
        try {
            let chained;
            for (let cursor = from; cursor < to;) {
                const end = Math.min(to, cursor + MAX_DELTA_BYTES);
                let d;
                try {
                    d = await this._fetchRecordingRange(tabInfo.paneId, cursor, end, tabInfo.paneEpoch, chained);
                } catch (error) {
                    // An evicted gap cannot be patched. Retry through a new
                    // atomic attach, which recovers through a live checkpoint.
                    if (error?.historyPermanent) {
                        try { pty.ws?.close(); } catch (_e) {}
                        return;
                    }
                    throw error;
                }
                if (tabInfo.finalizing || tabInfo.ws !== pty || tabInfo._bootstrapGen !== bootGen) return;
                if (!d || d.start !== cursor || d.end !== end ||
                    d.byteLength !== end - cursor || d.bytes?.byteLength !== d.byteLength) {
                    // Retry through a new atomic attach. Do not discard the
                    // hole, reset the decoder, or inject text into its stream.
                    try { pty.ws?.close(); } catch (_e) {}
                    return;
                }
                if (d.endCursor !== undefined) chained = d.endCursor;
                if (tabInfo._historyBrowsing) {
                    // Gap bytes remain authoritative in the recording. Consume
                    // socket sequencing without resizing or painting this view.
                    pty.applyGapPatch(d.bytes);
                } else if (!await this._parseRecordingRange(tabInfo, d, current, bytes => pty.applyGapPatch(bytes))) return;
                tabInfo.queuedSeq = pty.lastFrameEnd;
                cursor = end;
            }
            if (!tabInfo._historyBrowsing) this._fitVisibleTerminal(tabInfo);
            recovered = true;
        } finally {
            if (tabInfo._bootstrapGen === bootGen) tabInfo._gapInFlight = false;
            // applyGapPatch may encounter the next hole while this handler
            // owns the gate. Re-fire after relinquishing it, not before.
            if (recovered && tabInfo.ws === pty && !tabInfo.finalizing) pty.release?.();
        }
    }

    _scheduleCheckpointUpload(tabInfo) {
        if (tabInfo._serverStateAvailable) return;
        if (!tabInfo.serializeAddon || !tabInfo._ckptEnabled) return;
        clearTimeout(tabInfo._ckptTimer);
        tabInfo._ckptTimer = setTimeout(() => {
            tabInfo._ckptTimer = null;
            this._uploadCheckpoint(tabInfo);
        }, CHECKPOINT_QUIET_MS);
    }

    _uploadCheckpoint(tabInfo) {
        if (tabInfo._serverStateAvailable) return;
        const pty = tabInfo.ws;
        if (
            !tabInfo.serializeAddon ||
            !pty ||
            pty.mode !== 'hot' ||
            tabInfo.isDead || tabInfo._historyLoading || tabInfo._historyBrowsing || tabInfo.writePending || tabInfo.writeBuffer?.length ||
            !tabInfo.term ||
            tabInfo.paneEpoch === undefined ||
            tabInfo.drainedSeq === undefined
        )
            return;
        // SerializeAddon restores mouse tracking but omits its encoding.
        // A restored Pi pane would then emit X10 instead of the SGR reports
        // the running TUI expects. Preserve the actual encoding, not a
        // coder-specific guess or a forced global mouse mode.
        const encoding = tabInfo.term._core?.mouseStateService?.activeEncoding;
        const mouseMode = encoding === 'SGR' ? '\x1b[?1006h'
            : encoding === 'SGR_PIXELS' ? '\x1b[?1016h' : '';
        let ansi = '';
        try {
            let scrollback = isCoarseViewport() ? PHONE_CHECKPOINT_ROWS : LIVE_SCROLLBACK_ROWS;
            for (let attempt = 0; ; attempt++) {
                const snapshot = terminalSnapshot(tabInfo.term, tabInfo.serializeAddon, { scrollback });
                if (!snapshot && !mouseMode) return;
                // Pending parser bytes must remain last, including after the
                // mouse encoding that SerializeAddon does not carry.
                ansi = mouseMode + snapshot;
                // The server bounds UTF-8 bytes, not UTF-16 string length.
                const bytes = new TextEncoder().encode(ansi).byteLength;
                if (bytes <= MAX_CHECKPOINT_BYTES) break;
                // Never post a snapshot the server cannot accept. The cold
                // recording, not a truncated string, owns omitted history.
                if (scrollback === 0) return;
                const lines = Math.min(scrollback,
                    tabInfo.term.buffer?.active?.baseY ?? scrollback) + tabInfo.term.rows;
                const target = Math.max(0,
                    Math.floor(MAX_CHECKPOINT_BYTES * lines / bytes) - tabInfo.term.rows);
                scrollback = Math.min(scrollback - 1, target,
                    attempt ? Math.floor(scrollback / 2) : scrollback);
            }
        } catch (e) {
            console.error('[term] serialize failed:', e);
            return;
        }
        const payload = {
            epoch: tabInfo.paneEpoch,
            // Pixels omit an incomplete UTF-8 prefix held by the decoder.
            // Replay those bytes on restore rather than claiming they rendered.
            through: Math.max(0, tabInfo.drainedSeq - (pty.pendingUTF8Bytes ?? 0)),
            cols: tabInfo.term.cols,
            rows: tabInfo.term.rows,
            ansi,
        };
        // Fire-and-forget: a failed upload only means the next attach uses
        // the bounded-delta fallback instead of the snapshot.
        fetch(
            `/api/terminals/${encodeURIComponent(tabInfo.paneId)}/checkpoint`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            },
        )
            .then((res) => {
                if (res.ok) termPerfMark('ckpt-uploaded');
            })
            .catch(() => {});
    }

    _openTermAndViewport(tabInfo) {
        if (tabInfo._termOpened) {
            if (tabInfo._pendingViewport) tabInfo._pendingViewport();
            return;
        }
        clearTimeout(tabInfo._openFallbackTimer);
        tabInfo._termOpened = true;
        try {
            tabInfo.term.open(tabInfo.termContainer);
        } catch (e) {
            console.error('[term] open failed:', e);
        }
        // Prevent browser viewport jump when xterm focuses its hidden
        // textarea (moved out of createTab so hot tabs can open late).
        const textarea = tabInfo.termContainer.querySelector(
            'textarea.xterm-helper-textarea',
        );
        if (textarea) {
            const originalFocus = textarea.focus.bind(textarea);
            textarea.focus = (options) => {
                originalFocus({ preventScroll: true, ...options });
            };
        }
        // Hooks that need the open terminal's DOM (xterm viewport etc.).
        for (const hook of tabInfo._postOpenHooks || []) {
            try {
                hook(tabInfo.term);
            } catch (e) {
                console.error('[term] post-open hook failed:', e);
            }
        }
        tabInfo._postOpenHooks = [];
        this._observeTerminalPanel(tabInfo);
        if (tabInfo._pendingViewport) tabInfo._pendingViewport();
    }

    // FitAddon does not observe its container. Watch the actual panel so
    // drawers, splitters, input bars and CSS changes share one resize path.
    _observeTerminalPanel(tabInfo) {
        if (typeof ResizeObserver !== 'function' || tabInfo._panelObserver || !tabInfo.termContainer) return;
        tabInfo._panelObserver = new ResizeObserver(entries => {
            const rect = (entries || []).find(entry => entry.target === tabInfo.termContainer)?.contentRect;
            const changed = rect && (!tabInfo._panelBox || tabInfo._panelBox.width !== rect.width || tabInfo._panelBox.height !== rect.height);
            if (rect) tabInfo._panelBox = { width: rect.width, height: rect.height };
            this._queuePanelFit(tabInfo, { forceResize: Boolean(changed) });
        });
        tabInfo._panelObserver.observe(tabInfo.termContainer);
    }

    _terminalPanelVisible(tabInfo) {
        if (typeof document === 'undefined' || document.hidden) return false;
        const rect = tabInfo.termContainer?.getBoundingClientRect?.();
        return !rect || (rect.width > 0 && rect.height > 0);
    }

    _fitVisibleTerminal(tabInfo) {
        if (!this._terminalPanelVisible(tabInfo)) {
            tabInfo._pendingPanelFit = true;
            tabInfo._pendingForceResize = true;
            return;
        }
        tabInfo.fitAddon?.fit?.();
    }

    _queueActiveRefresh() {
        const tab = this.getActiveTab();
        if (tab) this._queuePanelFit(tab, { forceResize: true });
    }

    _refreshTerminalScreen(tabInfo) {
        tabInfo.term?._core?.viewport?.syncScrollArea?.(true);
        this._resyncViewportScroll(tabInfo);
        try { tabInfo.term?.refresh?.(0, Math.max(0, tabInfo.term.rows - 1)); }
        catch (error) { console.warn('[term] renderer refresh deferred:', error); }
    }

    _queuePanelFit(tabInfo, { forceResize = false } = {}) {
        tabInfo._pendingForceResize = Boolean(tabInfo._pendingForceResize || forceResize);
        if (tabInfo._panelFitRAF !== undefined && tabInfo._panelFitRAF !== null) return;
        const fit = () => {
            tabInfo._panelFitRAF = null;
            if (tabInfo.finalizing || tabInfo.isDead || tabInfo !== this.getActiveTab()) return;
            if (tabInfo._bootstrapGate || !this._terminalPanelVisible(tabInfo)) {
                tabInfo._pendingPanelFit = true;
                return;
            }
            tabInfo._pendingPanelFit = false;
            const force = tabInfo._pendingForceResize;
            tabInfo._pendingForceResize = false;
            this.fitActiveTerminal({ forceResize: force });
        };
        if (typeof requestAnimationFrame === 'function') tabInfo._panelFitRAF = requestAnimationFrame(fit);
        else fit();
    }

    // Called from each socket's onOpen. Hot tabs wait briefly for
    // ATTACH_HEAD (so the checkpoint can be written pre-open); everything
    // else opens immediately.
    _paneOpened(tabInfo) {
        if (tabInfo._termOpened) {
            if (tabInfo._pendingViewport) tabInfo._pendingViewport();
            return;
        }
        clearTimeout(tabInfo._openFallbackTimer);
        tabInfo._openFallbackTimer = setTimeout(
            () => this._openTermAndViewport(tabInfo),
            300,
        );
    }

    writeToTerminal(tabInfo, data) {
        // Disconnection and process exit do not dispose xterm. Already
        // received output still belongs to its history, including exit
        // sequences that leave the alternate screen. Only teardown cancels.
        if (tabInfo.finalizing) return;

        // First live/replay byte of an attach. Measured against
        // the socket-open mark so attach latency is attributable end-to-end.
        if (!tabInfo._perfWrote) {
            tabInfo._perfWrote = true;
            termPerfMark('first-write');
            if (tabInfo._perfAttachAt) {
                const attachMs = termPerfMeasureBetween(
                    'attach-to-first-write',
                    tabInfo._perfAttachAt,
                );
                console.info(
                    `[phi-perf] attach-to-first-write: ${attachMs.toFixed(0)}ms`,
                );
            }
        }

        if (tabInfo.loaderEl && !tabInfo.hasStarted) {
            tabInfo.hasStarted = true;
            const loader = tabInfo.loaderEl;
            loader.style.opacity = '0';
            setTimeout(() => {
                if (loader.parentNode) {
                    loader.remove();
                }
            }, 300);
            tabInfo.loaderEl = null;
        }

        tabInfo.writeBuffer += data;

        // Track PTY activity on output.
        tabInfo.lastOutputAt = Date.now();
        if (!tabInfo.isBusy) {
            tabInfo.isBusy = true;
            tabInfo.busyStartTime = Date.now();
            // If not manually pinned by the user, dynamically pin on the backend while busy.
            if (!tabInfo.pinned) {
                this.syncBackendPin(tabInfo.paneId, true);
            }
            // First byte after quiet is the only transition we need to render.
            // Subsequent writes stay in the same live-output state.
            this.updateDocumentTitle();
        }

        if (!tabInfo.writePending) {
            this._flushTerminalWrite(tabInfo);
        }
    }

    // Resolves bootstrap watermark waiters. Called wherever the pump
    // reaches quiescence (callback tail with an empty buffer, early
    // returns); resolving is always safe because every waiter owner
    // re-verifies socket, generation, and death before touching state.
    _runDrainWaiters(tabInfo) {
        const waiters = tabInfo._drainWaiters;
        if (!waiters || waiters.length === 0) return;
        tabInfo._drainWaiters = [];
        for (const resolve of waiters) {
            try {
                resolve();
            } catch (_e) {}
        }
    }

    // Resolves once the write queue drains past everything enqueued so
    // far — proving xterm parsed it — or immediately when already
    // quiescent or finalized. A disconnected pane must finish parsing.
    _drainSettled(tabInfo) {
        return new Promise((resolve) => {
            if (
                tabInfo.finalizing ||
                (!tabInfo.writePending && !tabInfo.writeBuffer?.length)
            ) {
                resolve();
            } else {
                if (!tabInfo._drainWaiters) tabInfo._drainWaiters = [];
                tabInfo._drainWaiters.push(resolve);
            }
        });
    }

    _flushTerminalWrite(tabInfo) {
        if (tabInfo.writePending || tabInfo._writeRetryTimer) return;
        // Quiescence runs drain waiters (bootstrap watermarks): every
        // byte enqueued so far is parsed at this point — the pump is
        // strictly FIFO and a pending batch would still be flagged above.
        // Owners re-verify state after awaiting, so resolving here is
        // always safe, including on dead tabs.
        if (tabInfo.finalizing || tabInfo.writeBuffer.length === 0) {
            this._runDrainWaiters(tabInfo);
            return;
        }

        // Capture follow state before xterm grows the buffer. This is the same
        // strict predicate used by the scroll-to-bottom button.
        const buffer = tabInfo.term?.buffer?.active;
        const followBottom =
            buffer &&
            buffer.viewportY >= buffer.baseY &&
            tabInfo.userFollowBottom !== false;
        let length = Math.min(MAX_WRITE_CHARS, tabInfo.writeBuffer.length);
        // Do not split an astral character at a UTF-16 boundary.
        const last = tabInfo.writeBuffer.charCodeAt(length - 1);
        if (length < tabInfo.writeBuffer.length && last >= 0xd800 && last <= 0xdbff) length--;
        const data = tabInfo.writeBuffer.slice(0, length);
        tabInfo.writeBuffer = tabInfo.writeBuffer.slice(length);
        tabInfo.writePending = true;
        let parsed = false;

        // Measures xterm parse+render time for each batch (slow
        // ones only). Recorded from buffer swap to write callback.
        const _writeT0 = performance.now();

        // Keep one bounded parse in flight. A refused write is retryable;
        // it must not remove bytes or let the drain watermark pass them.
        try {
            tabInfo.term.write(data, () => {
                parsed = true;
                termPerfMeasureSince('write-batch', _writeT0);
                tabInfo.writePending = false;
                // Quiescence (nothing left unparsed) resolves watermark
                // waiters: their bytes were enqueued before this point and
                // the pump is strictly FIFO. Runs before the tail recurse
                // so waiters observe parsed state even when more output
                // arrived meanwhile.
                if (tabInfo.writeBuffer.length === 0)
                    this._runDrainWaiters(tabInfo);
                if (tabInfo.finalizing) {
                    tabInfo.writeBuffer = '';
                    // Unblock watermark waiters even with data buffered:
                    // owners re-verify death and dissolve, so resolving
                    // here only ends the wait, never applies state.
                    this._runDrainWaiters(tabInfo);
                    return;
                }

                // xterm has parsed this complete batch, so its buffer state is
                // current. scrollToBottom changes ydisp, which is the coordinate
                // the viewport uses to set native scrollTop; synchronize after it.
                if (followBottom && tabInfo.userFollowBottom !== false) {
                    tabInfo.term.scrollToBottom();
                }
                tabInfo.term._core?.viewport?.syncScrollArea(true);

                // hot-v1: when the queue is fully drained, the xterm
                // state now reflects every byte up to queuedSeq. That makes
                // drainedSeq a valid checkpoint watermark — except while a
                // bootstrap delta is still pending: advancing now would vouch
                // for bytes below the live frontier that have not rendered.
                // The bootstrap sets the watermark explicitly on success.
                if (
                    tabInfo.writeBuffer.length === 0 &&
                    tabInfo.queuedSeq !== undefined &&
                    !tabInfo._bootstrapGate &&
                    (!tabInfo.ws || tabInfo.ws.mode === 'hot')
                ) {
                    if (tabInfo.queuedSeq >= (tabInfo.drainedSeq ?? 0)) {
                        tabInfo.drainedSeq = tabInfo.queuedSeq;
                        this._scheduleCheckpointUpload(tabInfo);
                    }
                }

                this._flushTerminalWrite(tabInfo);
            });
        } catch (e) {
            console.error('[term] write failed:', e);
            tabInfo.writePending = false;
            if (tabInfo.finalizing) {
                this._runDrainWaiters(tabInfo);
                return;
            }
            // A synchronous post-parse callback error must not duplicate
            // admitted bytes. A pre-admission refusal keeps the exact FIFO.
            if (!parsed) tabInfo.writeBuffer = data + tabInfo.writeBuffer;
            tabInfo._writeRetryTimer = setTimeout(() => {
                tabInfo._writeRetryTimer = null;
                this._flushTerminalWrite(tabInfo);
            }, 50);
        }
    }

    updateDirectModeUI(tab, skipFit = false) {
        this._setPiRpcActionVisibility(tab);

        // Save scroll state before DOM changes alter the terminal height
        if (tab && !tab.isDead && tab.isAtBottom === undefined) {
            const buffer = tab.term.buffer.active;
            tab.isAtBottom = buffer.viewportY >= buffer.baseY;
            tab.lastScrollY = buffer.viewportY;
        }

        if (tab.coder === 'pi-rpc') {
            tab.directMode = false;
            this.directModeToggle.classList.remove('active');
            this.inputBarContainer.classList.remove('direct-mode-active');
            this.inputBarContainer.classList.remove('hidden');
            this._renderPiRpcPresets();
        } else if (tab.directMode) {
            this.directModeToggle.classList.add('active');
            this.inputBarContainer.classList.add('direct-mode-active');
            this.inputBarContainer.classList.remove('hidden');
            this.presetsContainer.classList.add('hidden');
        } else {
            this.directModeToggle.classList.remove('active');
            this.inputBarContainer.classList.remove('direct-mode-active');
            this.inputBarContainer.classList.remove('hidden');
            this.presetsContainer.classList.remove('hidden');
            // Make sure presets exist and are populated
            this.renderPresets(tab.coder);
        }

        // Toggle Ctrl+T button visibility based on backend
        if (this.ctrlTBtn) {
            if (['opencode', 'pi'].includes(tab.coder)) {
                this.ctrlTBtn.classList.remove('hidden');
            } else {
                this.ctrlTBtn.classList.add('hidden');
            }
        }

        // skipFit is the NEVER-keyboard contract: the focus-driven
        // direct-mode exit toggles chrome whose layout shift must not
        // refit, resend, or scroll while the keyboard is moving.
        if (!skipFit) this.fitActiveTerminal();
    }

    // Mobile-only scrollback lane. Desktop always keeps the full
    // LIVE_SCROLLBACK_ROWS; under the fast-mode gate (forced on for
    // mobile viewports, or user fast_mode) a valid mobileScrollbackRows
    // setting shrinks new tabs. 0/unset/garbage = full: the fail-safe
    // direction is always toward visible history, never away.
    // Pure over (fastMode, setting) except reading the DOM gate, so it
    // is unit-testable with a stubbed body class.
    _liveScrollbackRows() {
        try {
            if (document?.body?.classList?.contains('fast-mode')) {
                const n = Number(this.app?.mobileScrollbackRows) || 0;
                if (n >= 500 && n <= LIVE_SCROLLBACK_ROWS) {
                    return Math.floor(n);
                }
            }
        } catch (_e) {
            /* fail-safe below */
        }
        return LIVE_SCROLLBACK_ROWS;
    }

    _connectTabSocket(tabInfo, initialCmd = '') {
        if (!tabInfo || tabInfo.isReview || tabInfo.isKanban || tabInfo.coder === 'pi-rpc') return;
        tabInfo._cachedScreen = null;
        if (tabInfo.pinned) {
            const fetchFn = (this.app?.scope && typeof this.app.scope.fetch === 'function')
                ? (url, opts) => this.app.scope.fetch(url, opts)
                : fetch;
            fetchFn(`/api/terminals/${tabInfo.paneId}/pin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pinned: true }),
            }).catch((err) =>
                console.error('[term] Failed to sync pin on backend:', err),
            );
        }

        const ws = new PTYWebSocket(
            tabInfo.paneId,
            (data) => {
                if (tabInfo.ws !== ws) return;
                this._paneData(tabInfo, data);
            },
            (control) => {
                if (tabInfo.ws !== ws) return;
                this.handleControlMessage(tabInfo, control, ws);
            },
            () => {
                if (tabInfo.ws !== ws) return;
                this._handleTerminalDisconnect(tabInfo);
            },
            () => {
                if (tabInfo.ws !== ws) return;
                tabInfo._perfAttachAt = performance.now();
                tabInfo._perfWrote = false;
                termPerfMark('ws-open');
                // Viewport activation waits for the hot bootstrap (or the
                // 300ms fallback) — _openTermAndViewport runs it after open.
                tabInfo._pendingViewport = () => {
                    try {
                        if (tabInfo === this.getActiveTab()) {
                            this.activateTabViewport(tabInfo, {
                                scrollToBottom: true,
                                autoReconnect: false,
                            });
                        } else {
                            this._fitVisibleTerminal(tabInfo);
                            this.sendResizeToBackend(tabInfo);
                        }
                    } catch (e) {
                        console.error(
                            '[term] Fit/resize error on initial socket open:',
                            e,
                        );
                    }
                };
                this._paneOpened(tabInfo);
                if (initialCmd) {
                    // Deliver startup command after terminal settles
                    setTimeout(() => {
                        if (
                            initialCmd.length > 16 ||
                            initialCmd.includes('\n')
                        ) {
                            this.sendInput(
                                tabInfo,
                                `\x1b[200~${initialCmd}\x1b[201~\r`,
                            );
                        } else {
                            this.sendInput(tabInfo, `${initialCmd}\r`);
                        }
                    }, 1000);
                }
            },
            this._hotOptions(tabInfo),
        );

        this._setCurrentTabSocket(tabInfo, ws);
    }

    createTab(
        paneId,
        sessionId,
        title,
        coder,
        workspace = '',
        cwd = '',
        pinned = true,
        marked = false,
        initialCmd = '',
        piRpcSessionPath = null,
        opencodeMode = null,
        initialPiBridge = null,
        options = null,
    ) {
        // If tab already exists, just switch to it
        if (this.tabs.has(paneId)) {
            // A reattach still carries the current HTTP bridge
            // baseline: seed it through ordering before switching.
            if (initialPiBridge != null)
                this._seedHttpPiBridge(
                    this.tabs.get(paneId),
                    initialPiBridge,
                );
            this.switchTab(paneId, { userInitiated: true });
            return;
        }

        const savedDraft = this.loadTabDraft(paneId);
        // Resolve the coder favicon: registry first (covers built-
        // ins and custom backends), then the legacy fallback map
        // for UI pseudo-tabs the registry doesn't advertise.
        let faviconUrl = CODER_FAVICONS[coder];
        // Resolve the coder favicon: registry first (covers built-
        // ins and custom backends), then the legacy fallback map
        // for UI pseudo-tabs the registry doesn't advertise.
        faviconUrl = logoFor(coder) || CODER_FAVICONS[coder];
        if (!faviconUrl) faviconUrl = 'vendor/logos/bash.jpg';

        // Create elements
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        if (pinned) tabEl.classList.add('pinned');
        tabEl.setAttribute('data-pane-id', paneId);
        // Tabs default to pinned (server keeps the PTY alive across WS
        // disconnects / reloads). Pinning is a session-protection concept,
        // not a position-lock - all tabs get drag-reorder regardless of
        // pin state (moveTabTo / applyTabOrder / saveTabOrder).
        tabEl.draggable = true;
        tabEl.addEventListener('dragstart', (e) =>
            this.handleTabDragStart(e, paneId),
        );
        tabEl.addEventListener('dragend', (e) => this.handleTabDragEnd(e));
        tabEl.addEventListener('dragover', (e) =>
            this.handleTabDragOver(e, paneId),
        );
        tabEl.addEventListener('dragleave', (e) => this.handleTabDragLeave(e));
        tabEl.addEventListener('drop', (e) => this.handleTabDrop(e, paneId));

        // Stash the worktree glyph + cwd on the tab DOM so the legend, the
        // tab-list dropdown, and the hover preview can read them without a tabs
        // Map lookup (the Map entry lands ~300 lines later - see NOTE below).
        // No native title attribute: the hiero hover card is the tooltip,
        // and a title attr set here would go stale on rename anyway.
        const glyph = worktreeGlyph(cwd);
        tabEl.dataset.worktreeGlyph = glyph;
        tabEl.dataset.cwd = cwd;
        tabEl.innerHTML = `
            <button class="tab-pin" title="Pin session (Keep alive overnight)"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg></button>
            <img class="tab-favicon" src="${faviconUrl}" alt="${coder}">
            <span class="tab-worktree-icon" aria-hidden="true">${glyph}</span>
            <span class="tab-shortcut-badge" aria-hidden="true"></span>
            <span class="tab-title ${marked ? 'marked' : ''}">${escapeHtml(title)}</span>
            <button class="tab-close">×</button>
        `;

        const termContainer = document.createElement('div');
        termContainer.className = 'term-container';
        termContainer.id = `term-${paneId}`;

        let loaderEl = null;
        if (coder !== 'review' && coder !== 'kanban' && coder !== 'pi-rpc') {
            loaderEl = document.createElement('div');
            loaderEl.className = 'tab-loader';
            loaderEl.innerHTML = `
                <div class="spinner-ring"></div>
                <div class="loader-text">Starting ${escapeHtml(title)}...</div>
            `;
            termContainer.appendChild(loaderEl);
        }

        this.tabsContainer.appendChild(tabEl);
        this.terminalsWrapper.appendChild(termContainer);

        // Hide empty state landing page on tab creation
        this.hideEmptyState();

        // NOTE: tab-list selector refresh is intentionally
        // NOT done here. createTab() still has 300+ lines to go (PTY
        // spawn, WS attach, xterm.js fit, etc.) before this.tabs.set()
        // runs at line ~1247. Calling these here would render against
        // a tabs Map that's one tab behind, so the newest tab would be
        // missing from the legend and overflow count until the next
        // event happened to trigger a refresh. Both are called below
        // immediately after the tabs.set instead.

        tabEl.addEventListener('click', (e) => {
            const currentPaneId = tabEl.getAttribute('data-pane-id');
            if (e.target.closest('.tab-close')) {
                e.stopPropagation();
                this.closeTab(currentPaneId);
            } else if (e.target.closest('.tab-pin')) {
                e.stopPropagation();
                this.togglePinTab(currentPaneId);
            } else {
                this.switchTab(currentPaneId, { userInitiated: true });
            }
        });

        tabEl.addEventListener('dblclick', (e) => {
            const titleEl = e.target.closest('.tab-title');
            if (!titleEl) return;
            e.preventDefault();
            e.stopPropagation();
            const currentPaneId = tabEl.getAttribute('data-pane-id');
            this.openTabRenamer(currentPaneId, titleEl);
        });

        if (coder === 'review' || coder === 'kanban' || coder === 'pi-rpc') {
            if (coder === 'review' || coder === 'pi-rpc') {
                termContainer.classList.add('review-panel');
            } else if (coder === 'kanban') {
                termContainer.classList.add('kanban-panel');
            }
            const tabInfo = {
                paneId,
                sessionId,
                title,
                coder,
                workspace,
                cwd,
                tabEl,
                termContainer,
                isDead: true,
                isReview: coder === 'review',
                isKanban: coder === 'kanban',
                isChatRpc: coder === 'pi-rpc',
                pinned: !!pinned,
                marked: !!marked,
            };
            if (coder === 'pi-rpc') {
                // Durable resume identity: the exact Pi session path for a
                // resumed tab, null for a fresh tab (Clear also sets null).
                tabInfo.sessionPath = piRpcSessionPath || null;
            }
            this.tabs.set(paneId, tabInfo);
            this._placeNewTabByWorkspace(paneId);
            this.switchTab(paneId);
            if (coder === 'pi-rpc') this.savePiRpcTabs();
            return;
        }

        // Initialize xterm.js instance. The preferred size is resolved
        // against FitAddon's measured grid on the first fit below.
        const term = new window.Terminal({
            allowTransparency: true,
            cursorBlink: true,
            cursorStyle: 'bar',
            fontSize: terminalPreferredFontSize(this.app?.terminalFontSize),
            fontFamily:
                this.app?.terminalFontFamily || 'JetBrains Mono, monospace',
            // Resident output scrolls locally. Older output remains in the
            // recording and loads through the manual history button; the
            // hot-v1 state attach stays bounded.
            // Mobile may shrink via _liveScrollbackRows (fast-mode gate);
            // desktop always keeps LIVE_SCROLLBACK_ROWS.
            scrollback: this._liveScrollbackRows(),
            theme: this.getTerminalTheme(coder),
            linkHandler: {
                activate: (_event, text) => {
                    openExternalLink(text);
                },
            },
        });

        const fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);

        const searchAddon = new window.SearchAddon.SearchAddon();
        term.loadAddon(searchAddon);

        this._installTerminalLinkProvider(term);

        // Screen-checkpoint serializer; loaded when the vendor
        // addon is present; its absence only disables client checkpoints
        // (attach then falls back to the bounded delta).
        let serializeAddon = null;
        if (window.SerializeAddon?.SerializeAddon) {
            serializeAddon = new window.SerializeAddon.SerializeAddon();
            term.loadAddon(serializeAddon);
        }

        // Open in DOM — deferred. Hot-v1 tabs wait for ATTACH_HEAD so the
        // screen checkpoint + bounded delta are written pre-open (one
        // render); legacy/fallback opens run via _paneOpened's 300ms guard.
        // _openTermAndViewport performs the actual open + textarea patch.

        // Register OSC 52 clipboard handler
        if (term.parser?.registerOscHandler) {
            term.parser.registerOscHandler(52, (data) => {
                const parts = data.split(';');
                if (parts.length < 2) return true;
                const base64Text = parts[1].replace(/[^A-Za-z0-9+/=]/g, '');
                if (base64Text === '?') return true;
                try {
                    const binaryString = atob(base64Text);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const text = new TextDecoder('utf-8').decode(bytes);
                    this._agentClipboardCopy(text);
                } catch (e) {
                    console.error('OSC 52 decode error:', e);
                }
                return true;
            });
        }

        // (textarea focus patch moved into _openTermAndViewport — the
        // textarea does not exist until term.open runs)

        // Right-click on terminal → copy xterm selection.
        // Uses capture phase on termContainer so we fire BEFORE xterm's own
        // contextmenu handler (which calls stopPropagation and blocks bubble-phase listeners).
        termContainer.addEventListener(
            'contextmenu',
            (e) => {
                const sel = term.getSelection();
                if (!sel) return;
                e.preventDefault();
                e.stopPropagation();
                this.copyTextRobustly(sel);
            },
            { capture: true },
        );

        term.attachCustomKeyEventHandler((e) => {
            if (
                e.type === 'keydown' &&
                this.app?.handlePanelResizeShortcut?.(e)
            ) {
                return false;
            }
            if (e.type === 'keydown' && this.handleInputToggleShortcut?.(e)) {
                return false;
            }
            const isMac = isMacPlatform();
            if (e.type === 'keydown') {
                const isCopy =
                    (isMac && e.metaKey && e.key.toLowerCase() === 'c') ||
                    (!isMac &&
                        e.ctrlKey &&
                        e.shiftKey &&
                        e.key.toLowerCase() === 'c');
                if (isCopy) {
                    const sel = term.getSelection();
                    if (sel) {
                        this.copyTextRobustly(sel);
                        e.preventDefault();
                        return false;
                    }
                }
            }
            // Support Ctrl/Cmd + (+/- / 0) zoom shortcuts inside xterm (pass through to browser/desktop)
            if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey) {
                const k = e.key;
                if (
                    k === '+' ||
                    k === '=' ||
                    k === '-' ||
                    k === '_' ||
                    k === '0' ||
                    k === 'Add' ||
                    k === 'Subtract'
                ) {
                    return false;
                }
            }
            // Support F5 reload (pass through to browser/desktop) or Shift+F5 / Ctrl+Shift+R (Reconnect all tabs)
            if (e.type === 'keydown' && (e.key === 'F5' || e.code === 'F5')) {
                if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    this.handleGlobalTabShortcuts(e);
                }
                return false;
            }
            if (
                e.type === 'keydown' &&
                (e.ctrlKey || e.metaKey) &&
                e.shiftKey &&
                !e.altKey &&
                (e.key === 'r' || e.key === 'R')
            ) {
                this.handleGlobalTabShortcuts(e);
                return false;
            }
            // Support Ctrl+Shift+F inside xterm
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
                if (e.type === 'keydown') {
                    this.handleGlobalTabShortcuts(e);
                }
                return false;
            }
            // Support Alt+1..9 (and Cmd+1..9 / Option+1..9 on macOS) tab switching inside xterm
            const isTabSwitchModifier =
                !e.ctrlKey && !e.shiftKey && (e.altKey || (isMac && e.metaKey));
            if (isTabSwitchModifier && tabShortcutDigit(e) !== null) {
                if (e.type === 'keydown') {
                    this.handleGlobalTabShortcuts(e);
                }
                return false;
            }
            if (e.key === 'Alt') {
                this.updateTabShortcutHints(e.type === 'keydown');
            }
            // In non-direct mode: forward control keys (Enter, arrows, Esc,
            // ...) straight to the PTY — the same map the empty staged-input
            // bar uses, but with no emptiness gate: a draft in the input bar
            // must not change what Enter means on a focused terminal
            // (answering a TUI prompt mid-draft keeps the draft staged).
            if (
                !tabInfo.directMode &&
                e.type === 'keydown' &&
                this._forwardKeyToPty(e, tabInfo)
            ) {
                return false;
            }
            // In non-direct mode: redirect printable keystrokes to the input textarea
            if (
                !tabInfo.directMode &&
                e.type === 'keydown' &&
                e.key.length === 1 &&
                !e.ctrlKey &&
                !e.altKey &&
                !e.metaKey
            ) {
                // preventDefault: focus moves to the textarea mid-keydown, so
                // without it the browser's default insertion lands there too
                // and doubles the character.
                e.preventDefault();
                this.inputTextArea.value += e.key;
                this.inputTextArea.focus({ preventScroll: true });
                const len = this.inputTextArea.value.length;
                this.inputTextArea.setSelectionRange(len, len);
                // Synthetic 'input': preventDefault suppresses the native one,
                // but the textarea's input listeners (spam-scroll,
                // lastInputValue, autosize, prompt-history cursor reset)
                // still need to run.
                this.inputTextArea.dispatchEvent(
                    new Event('input', { bubbles: true }),
                );
                return false;
            }
            // Prevent browser default for standard CLI shortcuts in direct mode
            if (tabInfo.directMode && e.ctrlKey && !e.altKey && !e.shiftKey) {
                const key = e.key.toLowerCase();
                if (['o', 's', 'p', 'f', 'r', 'g'].includes(key))
                    e.preventDefault();
            }
            return true;
        });

        term.onSelectionChange(() => {
            const sel = term.getSelection();
            if (sel) {
                this.copyTextRobustly(sel, true);
            }
        });

        // Legacy OpenCode's full-screen TUI needs keyboard scroll events.
        // Mini uses normal xterm scrollback: never intercept its wheel or
        // touch gestures and never inject TUI navigation keys into it.
        termContainer.addEventListener(
            'wheel',
            (e) => {
                if (tabInfo._historyBrowsing || tabInfo.coder !== 'opencode' || isOpenCodeMini(tabInfo)) return;

                const isUp = e.deltaY < 0;

                // Scale scroll amount from the wheel delta for natural-feeling speed
                // Math.abs(deltaY) is typically ~100 for a single notch; clamp to a sane range
                const lines = Math.max(
                    1,
                    Math.min(Math.round(Math.abs(e.deltaY) / 40), 8),
                );

                e.preventDefault();
                e.stopPropagation();
                const seq = isUp ? '\x1b\x19' : '\x1b\x05';
                const payload = seq.repeat(lines);
                if (tabInfo.ws && !tabInfo.isDead) {
                    tabInfo.ws.sendInput(payload);
                }
            },
            { capture: true, passive: false },
        );

        // Touch scrolling for OpenCode alt screen (TUI) on mobile viewports
        let termTouchStartY = 0;
        let termTouchRemainder = 0;
        termContainer.addEventListener(
            'touchstart',
            (e) => {
                if (tabInfo._historyBrowsing || tabInfo.coder !== 'opencode' || isOpenCodeMini(tabInfo)) return;
                if (e.touches.length === 1) {
                    termTouchStartY = e.touches[0].clientY;
                    termTouchRemainder = 0;
                }
            },
            { capture: true, passive: false },
        );

        termContainer.addEventListener(
            'touchmove',
            (e) => {
                if (tabInfo._historyBrowsing || tabInfo.coder !== 'opencode' || isOpenCodeMini(tabInfo)) return;
                if (e.touches.length === 1 && termTouchStartY !== null) {
                    const currentY = e.touches[0].clientY;
                    const rawDelta = currentY - termTouchStartY;
                    const totalDelta = rawDelta + termTouchRemainder;
                    const cellHeight = 16;

                    const lines = Math.floor(Math.abs(totalDelta) / cellHeight);
                    if (lines > 0) {
                        e.preventDefault();
                        e.stopPropagation();

                        const isUp = totalDelta > 0; // swipe down -> scroll up
                        const seq = isUp ? '\x1b\x19' : '\x1b\x05';
                        const payload = seq.repeat(lines);

                        if (tabInfo.ws && !tabInfo.isDead) {
                            tabInfo.ws.sendInput(payload);
                        }

                        const consumed =
                            lines * cellHeight * (totalDelta > 0 ? 1 : -1);
                        termTouchRemainder = totalDelta - consumed;
                        termTouchStartY = currentY;
                    }
                }
            },
            { capture: true, passive: false },
        );

        // Setup terminal bell notification sound.
        const bellAudio = new Audio('vendor/bell.wav');
        bellAudio.volume = 0.3;
        term.onBell(() => {
            bellAudio.currentTime = 0;
            bellAudio.play().catch(() => {});
        });

        // Graceful WebGL/Canvas renderer.
        //
        // The try/catch only covers a renderer that fails to construct. A
        // context lost at runtime is the other failure, and the damaging one:
        // the addon keeps drawing into a dead GL context, so the terminal
        // renders garbage and never recovers. Mobile GPUs drop contexts under
        // memory pressure and on backgrounding, and heavy scrollback churn can
        // provoke it on the desktop too. Disposing hands rendering back to the
        // DOM renderer -- slower, but correct.
        try {
            const webgl = new window.WebglAddon.WebglAddon();
            if (typeof webgl.onContextLoss === 'function') {
                webgl.onContextLoss(() => {
                    console.warn(
                        '[term] WebGL context lost; falling back to the DOM renderer',
                    );
                    try {
                        webgl.dispose();
                    } catch (e) {
                        console.error('[term] WebGL dispose failed:', e);
                    }
                    requestAnimationFrame(() => {
                        const tab = this.tabs.get(paneId);
                        if (tab) this._queuePanelFit(tab, { forceResize: true });
                    });
                });
            }
            term.loadAddon(webgl);
            console.log('[term] Loaded WebGL hardware acceleration');
        } catch (_e) {
            console.warn('[term] Falling back to standard canvas renderer');
        }

        // Load Unicode 11 Addon for correct emoji cell width measurements
        try {
            const unicode11 = new window.Unicode11Addon.Unicode11Addon();
            term.loadAddon(unicode11);
            term.unicode.activeVersion = '11';
            console.log('[term] Loaded Unicode 11 character width addon');
        } catch (e) {
            console.warn('[term] Failed to load Unicode 11 addon:', e);
        }

        const activeWS =
            workspace ||
            (this.app.sessionsManager
                ? this.app.sessionsManager.activeWorkspace
                : '');
        const activeCWD =
            cwd ||
            (this.app.sessionsManager
                ? this.app.sessionsManager.activeCWD
                : '');

        const tabInfo = {
            paneId,
            sessionId,
            title,
            coder,
            workspace: activeWS,
            cwd: activeCWD,
            // Pin the server's launch mode to this pane. Older servers and
            // profiles with no advertised mode retain legacy behavior.
            opencodeMode: coder === 'opencode'
                ? (opencodeMode || getCoder(coder)?.opencode_mode || 'legacy')
                : null,
            term,
            fitAddon,
            searchAddon,
            tabEl,
            termContainer,
            // Per-coder default focus mode. Shell tabs (is_shell: true
            // in the registry) and btop open in focused/direct mode —
            // keyboard goes straight to the terminal, no input bar
            // visible. AI-coder tabs keep the staged-input flow as
            // default because that's the whole phi workflow: queue
            // prompts, attach files, Ctrl+Shift+X chip. DirectMode is
            // not persisted — restored tabs pick this up via createTab()
            // on each load. Custom profiles can opt into direct mode.
            directMode: inputMode(coder) === 'direct',
            isDead: false,
            isAtBottom: true,
            isBtop: title === 'btop',
            pinned: !!pinned,
            marked: !!marked,
            // Per-tab staged input. The DOM textarea + stagedAttachments
            // hold the ACTIVE tab's draft; these fields park it while the
            // tab is inactive (written on switch-away, read on switch-in).
            draft: savedDraft.draft || '',
            draftAttachments: savedDraft.draftAttachments || [],
            lastOutputAt: undefined,
            isBusy: false,
            isAttention: false,
            userTaskActive: false,
            userTaskStartTime: null,
            busyStartTime: null,
            // Keep one xterm parse in flight; later output accumulates here.
            writeBuffer: '',
            writePending: false,
            loaderEl: loaderEl,
            hasStarted: false,
            // hot-v1 bookkeeping.
            serializeAddon,
            _termOpened: false,
            _ckptEnabled: true,
            paneEpoch: undefined,
            paneOldest: undefined,
            queuedSeq: undefined,
            drainedSeq: undefined,
            // Scrollbar follow mode. xterm's native syncScrollArea leaves
            // the scrollbar stale when PTY output grows without a layout
            // reflow (e.g., the input bar auto-resize that fires when the
            // user types). Tracking this flag separately lets us:
            //   - Snap to bottom on PTY output when at bottom (real follow)
            //   - Stop overriding xterm's scroll position when user wheels up
            //   - Re-engage follow if user scrolls back to bottom
            // Without it, the scrollbar shows the line from N minutes ago
            // while content scrolls past, then snaps when the user wheels.
            userFollowBottom: true,
            _piTitleRevision: -1,
        };

        if (options?.live === false) {
            tabInfo._detachedCache = true;
            tabInfo.ws = null;
            if (options?.cachedScreen) {
                tabInfo._cachedScreen = options.cachedScreen;
                this._openTermAndViewport(tabInfo);
                const { ansi, cols, rows } = options.cachedScreen;
                if (cols > 0 && rows > 0) {
                    try { tabInfo.term.resize(cols, rows); } catch {}
                }
                if (ansi) {
                    if (tabInfo.loaderEl) {
                        try { tabInfo.loaderEl.remove(); } catch {}
                        tabInfo.loaderEl = null;
                    }
                    try {
                        tabInfo.term.write(ansi);
                    } catch (e) {
                        console.error('[term] failed to write cached screen:', e);
                    }
                }
            }
        } else {
            this._connectTabSocket(tabInfo, initialCmd);
        }

        this.tabs.set(paneId, tabInfo);
        this._placeNewTabByWorkspace(paneId);
        // Seed the spawn/resume/restore HTTP bridge baseline before
        // any socket callback can arrive; the fresh attach confirms
        // or advances it through the same ordering check.
        if (initialPiBridge != null)
            this._seedHttpPiBridge(tabInfo, initialPiBridge);

        // A real scroll gesture takes ownership away from any in-flight
        // fit/reflow restore. Do not use term.onScroll for this: xterm emits
        // it for our own programmatic scrolls too, which would weaken the
        // proven 10ms/300ms stabilization loop. DOM input events identify
        // user intent without changing that loop's timing or behavior.
        const cancelFollowForUserScroll = () =>
            this._cancelScrollFollowForUserScroll(tabInfo);
        const loadNewer = () => {
            const buffer = tabInfo.term?.buffer?.active;
            if (tabInfo._historyBrowsing && buffer && buffer.viewportY >= buffer.baseY) {
                this._restoreLatestHistory(tabInfo);
            }
        };
        termContainer.addEventListener('wheel', e => {
            if (e.deltaY > 0) loadNewer();
        }, { capture: true, passive: true });
        let touchY;
        termContainer.addEventListener('touchstart', e => { touchY = e.touches?.[0]?.clientY; }, { passive: true });
        termContainer.addEventListener('touchmove', e => {
            if (e.touches?.length !== 1) return;
            if (e.touches[0].clientY < touchY) loadNewer();
        }, { passive: true });
        // Detect native buffer eviction too; the manual button can recover it.
        term._core?._bufferService?.buffers?.normal?.lines?.onTrim?.(() => {
            if (!tabInfo._historyLoading) tabInfo._historyOmitted = true;
            this._updateHistoryButton(tabInfo);
        });
        termContainer.addEventListener('wheel', cancelFollowForUserScroll, {
            capture: true,
            passive: true,
        });
        termContainer.addEventListener(
            'touchstart',
            cancelFollowForUserScroll,
            { capture: true, passive: true },
        );
        // Pointerdown needs the xterm viewport, which only exists after the
        // deferred open — install it post-open instead.
        tabInfo._postOpenHooks = tabInfo._postOpenHooks || [];
        tabInfo._postOpenHooks.push((openedTerm) => {
            openedTerm.element
                ?.querySelector('.xterm-viewport')
                ?.addEventListener('pointerdown', cancelFollowForUserScroll, {
                    capture: true,
                    passive: true,
                });
        });

        // Escape hatch: when the DOM scroll area is stale, wheel-down clamps
        // at a fake bottom while real output sits below (viewportY < baseY).
        // Detect the clamp and scroll the buffer directly — reaching the true
        // bottom re-engages follow via the scroll listeners in the button
        // block below. Registered bubble-phase so the opencode capture
        // handler's stopPropagation keeps opencode tabs out of this path.
        termContainer.addEventListener(
            'wheel',
            (e) => {
                if (e.deltaY <= 0) return;
                const buf = tabInfo.term?.buffer?.active;
                if (!buf || buf.viewportY >= buf.baseY) return;
                const vp =
                    tabInfo.term.element?.querySelector('.xterm-viewport');
                if (!vp) return;
                if (vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 1) {
                    // Same wheel→lines scaling as the opencode handler above.
                    const lines = Math.max(
                        1,
                        Math.min(Math.round(e.deltaY / 40), 8),
                    );
                    tabInfo.term.scrollLines(lines);
                }
            },
            { passive: true },
        );

        // Scroll-to-bottom affordance: a small floating button that
        // fades in when the user scrolls up into scrollback, fades out
        // when they return to the live bottom. Click jumps to the
        // bottom. Pattern is universal in TUI/web-terminal apps (iTerm,
        // VS Code terminal, Hyper, etc.) and removes the daily friction
        // of "I scrolled up to read something, now I can't find my way
        // back to live output."
        //
        // MUST come AFTER `const tabInfo = { ... }`. The TDZ scope for
        // a `const` starts at the top of the enclosing block, so any
        // `tabInfo.X = ...` assignment above the declaration throws
        // "Cannot access 'tabInfo' before initialization" at runtime.
        // Earlier revisions put this block right after `term.open()`
        // which is BEFORE the tabInfo declaration and broke every
        // spawn-new-session. Keep it after this.tabs.set().
        const scrollToBottomBtn = document.createElement('button');
        scrollToBottomBtn.className = 'scroll-to-bottom-btn hidden';
        scrollToBottomBtn.setAttribute('type', 'button');
        scrollToBottomBtn.setAttribute(
            'aria-label',
            'Jump to bottom of output',
        );
        scrollToBottomBtn.title = 'Jump to bottom';
        scrollToBottomBtn.innerHTML = '\u2193'; // ↓
        scrollToBottomBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (tabInfo._historyBrowsing) {
                this._restoreLatestHistory(tabInfo);
            } else {
                tabInfo.term.scrollToBottom();
            }
            this._spamScrollToBottom(tabInfo);
            // Explicit jump-to-bottom click re-engages follow mode.
            tabInfo.userFollowBottom = true;
            scrollToBottomBtn.classList.add('hidden');
        });
        termContainer.appendChild(scrollToBottomBtn);
        tabInfo.scrollToBottomBtn = scrollToBottomBtn;

        // Mirror the bottom affordance at the top of the viewport. An older
        // book replaces the local view only on explicit activation, never
        // because a wheel, touch, scrollbar, or parser reached row zero.
        const loadHistoryBtn = document.createElement('button');
        loadHistoryBtn.className = 'load-history-btn hidden';
        loadHistoryBtn.type = 'button';
        loadHistoryBtn.setAttribute('aria-label', 'Load older terminal history');
        loadHistoryBtn.addEventListener('mousedown', e => e.preventDefault());
        loadHistoryBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (!loadHistoryBtn.disabled) this._loadColdHistory(tabInfo);
        });
        termContainer.appendChild(loadHistoryBtn);
        tabInfo.loadHistoryBtn = loadHistoryBtn;
        this._updateHistoryButton(tabInfo);

        const updateScrollBtn = () => {
            this._updateHistoryButton(tabInfo);
            if (
                tabInfo.isDead ||
                tabInfo.coder === 'review' ||
                tabInfo.coder === 'kanban' ||
                tabInfo.coder === 'pi-rpc'
            ) {
                scrollToBottomBtn.classList.add('hidden');
                return;
            }
            const buf = tabInfo.term?.buffer?.active;
            if (!buf) return;
            const atBottom = buf.viewportY >= buf.baseY;
            if (atBottom && !tabInfo._historyBrowsing) {
                scrollToBottomBtn.classList.add('hidden');
            } else {
                scrollToBottomBtn.classList.remove('hidden');
            }
        };
        if (term.onScroll) {
            term.onScroll(updateScrollBtn);
            // Re-engage follow mode when the user scrolls back to bottom.
            // Wheel/touch inputs disabled follow by setting
            // userFollowBottom = false; this reverses it once they return
            // to the live tail. Lets the user "release" and re-follow
            // without needing to click Jump-to-bottom.
            term.onScroll(() => {
                const b = tabInfo.term?.buffer?.active;
                if (b && b.viewportY >= b.baseY) {
                    tabInfo.userFollowBottom = true;
                }
            });
        }
        term.onResize?.(updateScrollBtn);
        term.buffer?.onBufferChange?.(updateScrollBtn);
        // xterm's public onScroll fires only for PROGRAMMATIC scrolls: the
        // vendored build passes suppressScrollEvent=true for user wheel /
        // scrollbar input (Viewport._handleScroll), so the two onScroll
        // subscriptions above never fire for real user gestures. The DOM
        // 'scroll' event is the signal those gestures do produce. It does
        // not bubble — listen in the capture phase on termContainer. The
        // capture listener fires BEFORE xterm's own scroll handler updates
        // the buffer, so defer one frame (house rAF-coalesce pattern) to
        // read fresh coordinates.
        let viewportScrollRafPending = false;
        termContainer.addEventListener(
            'scroll',
            () => {
                if (viewportScrollRafPending) return;
                viewportScrollRafPending = true;
                requestAnimationFrame(() => {
                    viewportScrollRafPending = false;
                    updateScrollBtn();
                    const b = tabInfo.term?.buffer?.active;
                    if (b) {
                        if (b.viewportY >= b.baseY) {
                            tabInfo.userFollowBottom = true;
                        } else {
                            this._cancelScrollFollowForUserScroll(tabInfo);
                        }
                    }
                });
            },
            { capture: true, passive: true },
        );
        termContainer.addEventListener(
            'keydown',
            (e) => {
                if (['PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
                    this._cancelScrollFollowForUserScroll(tabInfo);
                }
            },
            { capture: true, passive: true },
        );
        // Read coordinates after the parser completes, not before the write.
        // Checkpoint restores and buffer switches can change button visibility.
        const origWrite = tabInfo.term.write.bind(tabInfo.term);
        tabInfo.term.write = (data, cb) => origWrite(data, () => {
            cb?.();
            updateScrollBtn();
        });

        // Refresh the tab-list selector NOW that the tab is registered in
        // this.tabs. Previously this was called much earlier in
        // createTab (line ~899) which left the selector one tab
        // behind until something else triggered a re-render. Now it
        // always reflects the full tab set.
        this.updateTabOverflow();

        // Staged mode only gates typing, not terminal protocol replies.
        // Full-screen Pi scrolls its own transcript via SGR mouse reports;
        // dropping these leaves a perfectly drawn but unscrollable screen.
        // Route through tabInfo.ws so a reconnect swaps the destination.
        let terminalUserInput = false;
        term._core?.coreService?.onUserInput?.(() => { terminalUserInput = true; });
        term.onData((data) => {
            const fromUser = terminalUserInput;
            terminalUserInput = false;
            // Archive queries must not send old DSR/OSC/DCS replies into the
            // live app. Keep real keyboard/IME/paste input distinguishable.
            if ((tabInfo._historyParsing || tabInfo._historyBrowsing) && !fromUser) return;
            const protocolReply =
                /^(?:\x1b\[<\d+;\d+;\d+[Mm])+$/.test(data) ||
                /^\x1b\[\??[\d;:]*[cnRu]$/.test(data);
            if (tabInfo.directMode || protocolReply) {
                this.sendInput(tabInfo, data);
                if (tabInfo.directMode && data.includes('\r')) {
                    this._spamScrollToBottom(tabInfo);
                }
            }
        });

        // X10 mouse reports use byte-valued strings, not UTF-8 text.
        // Forwarding through sendInput would corrupt non-ASCII coordinates.
        term.onBinary?.((data) => {
            if (!tabInfo.isDead && !tabInfo._historyParsing && !tabInfo._historyBrowsing && tabInfo.ws) tabInfo.ws.sendBinaryInput(data);
        });

        // Double click terminal → toggle direct focus mode
        termContainer.addEventListener('dblclick', (e) => {
            e.preventDefault();
            const tab = tabInfo;
            if (tab) {
                // 1. Capture scroll state BEFORE any focus or UI changes
                const buffer = tab.term.buffer.active;
                tab.isAtBottom = buffer.viewportY >= buffer.baseY;
                tab.lastScrollY = buffer.viewportY;

                // 2. Toggle mode
                tab.directMode = !tab.directMode;

                // 3. Focus first so focus-induced browser scroll resets are captured
                if (tab.directMode) {
                    term.focus();
                } else {
                    this.inputTextArea.focus({ preventScroll: true });
                }

                // 4. Update UI and fit (which will restore the scroll perfectly)
                this.updateDirectModeUI(tab);
            }
        });

        // Switch to the newly created tab
        this.switchTab(paneId);
        this.saveTabsState();
        if (document.body.classList.contains('show-tab-shortcuts')) {
            this.updateTabShortcutHints(true);
        }

        // Initial fit delay to let rendering engine draw
        setTimeout(() => {
            if (tabInfo === this.getActiveTab()) {
                this.activateTabViewport(tabInfo, {
                    scrollToBottom: true,
                    autoReconnect: true,
                });
            }
        }, 100);
    }

    // A user-initiated finalization closes the PTY WebSocket too. Its
    // onclose callback is asynchronous, so it can arrive after the tab
    // teardown starts; that expected close must not masquerade as a lost
    // terminal or offer to reconnect a tab the user just closed.
    _handleTerminalDisconnect(tabInfo) {
        if (tabInfo.finalizing) return;

        // Deliberately not written into the terminal buffer: the overlay,
        // the disconnect banner and the toast below all say this already,
        // and unlike them a buffer write is permanent scrollback that
        // survives every later reconnect.
        tabInfo.isDead = true;
        this._refreshPiBridgeModels(tabInfo);
        // A dead socket orphans the pending native Compact waiter:
        // drop it and report unknown once for the still-current tab.
        this._invalidatePiBridgeCompact?.(tabInfo, true);
        this._updateHistoryButton(tabInfo);
        tabInfo.tabEl.classList.add('dead');
        this.updateDocumentTitle();
        this._showReconnectOverlay(tabInfo);
        this.maybeAutoReconnect(tabInfo);
        this.updateDisconnectBanner();
        // Toast so the user notices the drop even when they're focused on
        // a different tab. The on-terminal reconnect overlay stays for the
        // local UX; this toast covers the peripheral case.
        if (this.app?.showToast) {
            this.app.showToast(
                `Connection lost on "${tabInfo.title || tabInfo.coder || 'tab'}"`,
                {
                    type: 'error',
                    title: 'Terminal disconnected',
                    duration: 8000,
                },
            );
        }
    }

    renderPiRpcStatusBar() {
        const bar = this.piRpcStatusBar;
        if (!bar) return;
        const activeTab = this.getActiveTab();
        let raw = null;
        if (activeTab?.coder === 'pi-rpc') {
            raw = getPiRpcStatus(activeTab.paneId);
        } else if (
            activeTab?.coder === 'pi' &&
            this._piBridgeContextEligible(activeTab)
        ) {
            // Capable Pi PTY tabs reuse the same meter, formatting,
            // thresholds, and progressbar semantics; only real
            // cwd/model/tokens/window are adapted in.
            raw = this._piBridgeStatusFor(activeTab);
        } else {
            bar.classList.add('hidden');
            bar.replaceChildren();
            this._updatePiThinkingButton();
            return;
        }
        const display = formatPiRpcStatus(raw);
        // CWD: ~/code/ae style — replace home with ~, truncate gracefully
        let cwdDisplay = display.cwd;
        if (cwdDisplay && cwdDisplay !== '—') {
            cwdDisplay = cwdDisplay
                .replace(/^\/Users\/[^/]+/, '~')
                .replace(/^\/home\/[^/]+/, '~');
        }
        const tokens = [];
        if (display.input !== '—') tokens.push(`↑${display.input}`);
        if (display.output !== '—') tokens.push(`↓${display.output}`);
        if (display.cacheRead !== '—' && display.cacheRead !== '0')
            tokens.push(`R${display.cacheRead}`);
        if (
            display.cacheWrite !== '—' &&
            display.cacheWrite !== '0' &&
            display.cacheWrite !== '0.0'
        )
            tokens.push(`W${display.cacheWrite}`);
        const leftText = tokens.join('  ');
        const modelRight =
            display.model !== '—'
                ? `${display.model}${display.thinking !== '—' ? ` • ${display.thinking}` : ''}`
                : display.thinking !== '—'
                  ? display.thinking
                  : '';

        // Thin context meter — replaces the 203.5K / 1M text, lives in statusbar
        const usedTokens = raw?.contextUsedTokens;
        const windowTokens = raw?.contextWindowTokens;
        const ratioKnown =
            typeof usedTokens === 'number' &&
            Number.isFinite(usedTokens) &&
            typeof windowTokens === 'number' &&
            Number.isFinite(windowTokens) &&
            windowTokens > 0;
        const ratioExact = ratioKnown
            ? Math.min(100, Math.max(0, (usedTokens / windowTokens) * 100))
            : null;
        const ratioPercent =
            ratioExact !== null ? Math.round(ratioExact * 10) / 10 : null;
        let fillTheme = '';
        if (ratioExact !== null) {
            if (ratioExact < 40) fillTheme = ' pi-rpc-context-meter-fill--low';
            else if (ratioExact <= 70)
                fillTheme = ' pi-rpc-context-meter-fill--mid';
            else fillTheme = ' pi-rpc-context-meter-fill--high';
        }
        const meterEl = document.createElement('span');
        meterEl.className = 'pi-rpc-context-meter pi-rpc-status-meter';
        meterEl.setAttribute('role', 'progressbar');
        meterEl.setAttribute('aria-valuemin', '0');
        meterEl.setAttribute('aria-valuemax', '100');
        if (ratioPercent !== null)
            meterEl.setAttribute('aria-valuenow', String(ratioPercent));
        meterEl.setAttribute('aria-label', `Context: ${display.context}`);
        const fill = document.createElement('span');
        // Keep legacy green/yellow/red for backward compat but primary is low/mid/high theme
        let legacy = '';
        if (ratioExact !== null) {
            if (ratioExact < 40) legacy = ' pi-rpc-context-meter-fill--green';
            else if (ratioExact <= 70)
                legacy = ' pi-rpc-context-meter-fill--yellow';
            else legacy = ' pi-rpc-context-meter-fill--red';
        }
        fill.className =
            `pi-rpc-context-meter-fill${fillTheme}${legacy}`.trim();
        fill.style.width = ratioPercent === null ? '0%' : `${ratioPercent}%`;
        const meterText = document.createElement('span');
        meterText.className = 'pi-rpc-context-meter-text';
        meterText.textContent = display.context;
        meterEl.append(fill, meterText);

        bar.classList.remove('hidden');
        const cwdEl = document.createElement('div');
        cwdEl.className = 'pi-rpc-status-cwd';
        cwdEl.textContent = cwdDisplay;
        cwdEl.title = raw?.cwd || display.cwd;

        const mainRow = document.createElement('div');
        mainRow.className = 'pi-rpc-status-main';

        const leftEl = document.createElement('span');
        leftEl.className = 'pi-rpc-status-tokens';
        leftEl.textContent = leftText;

        const rightEl = document.createElement('span');
        rightEl.className = 'pi-rpc-status-model';
        rightEl.textContent = modelRight;
        if (modelRight) rightEl.title = modelRight;

        if (meterEl) mainRow.append(leftEl, meterEl, rightEl);
        else mainRow.append(leftEl, rightEl);
        bar.replaceChildren(cwdEl, mainRow);
        this._updatePiThinkingButton();
    }

    _setPiRpcActionVisibility(tab) {
        const hidden = tab?.coder === 'pi-rpc';
        for (const element of [this.copyInputBtn, this.directModeToggle]) {
            element?.classList.toggle('hidden', hidden);
        }
        if (hidden) this.directModeToggle?.classList.remove('active');
        this._updatePiThinkingButton();
    }

    _updatePiThinkingButton() {
        if (!this.piThinkingBtn) return;
        const tab = this.getActiveTab();
        if (tab?.coder === 'pi') {
            const level = this._piBridgeThinkingEligible(tab)
                ? tab.piBridge.thinking_level
                : '';
            const known =
                typeof level === 'string' &&
                PI_BRIDGE_THINKING_LEVELS.includes(level);
            const cls = known ? thinkingLevelClass(level) : '';
            const pending = this._piRpcThinkingPending?.paneId === tab.paneId;
            this.piThinkingBtn.className = `direct-mode-btn pi-thinking-btn${cls ? ` pi-thinking-btn--${cls}` : ''}${pending ? ' disabled' : ''}`;
            this.piThinkingBtn.disabled =
                !!pending || tab.isDead === true || !tab.ws || tab.ws.readyState === 3;
            this.piThinkingBtn.title = known
                ? `Thinking: ${level}`
                : 'Cycle Pi Thinking level';
            this.piThinkingBtn.setAttribute(
                'aria-label',
                known ? `Thinking ${level}; cycle level` : 'Cycle Pi Thinking level',
            );
            this.piThinkingBtn.classList.remove('hidden');
            return;
        }
        if (tab?.coder !== 'pi-rpc') {
            this.piThinkingBtn.classList.add('hidden');
            return;
        }

        const raw = getPiRpcStatus(tab.paneId);
        const fmt = raw ? formatPiRpcStatus(raw) : null;
        const rawLevel = raw?.thinking ?? fmt?.thinking ?? '';
        const level =
            rawLevel && rawLevel !== '—'
                ? String(rawLevel)
                : this._piThinkingLevels?.get(tab.paneId) || 'off';
        const cls = thinkingLevelClass(level);
        const isPending = this._piRpcThinkingPending?.paneId === tab.paneId;
        this.piThinkingBtn.className = `direct-mode-btn pi-thinking-btn pi-thinking-btn--${cls}${isPending ? ' disabled' : ''}`;
        this.piThinkingBtn.disabled = !!isPending;
        const label = cls === 'xhigh' ? `${level} (max)` : level;
        this.piThinkingBtn.title = `Thinking: ${label}`;
        this.piThinkingBtn.setAttribute('aria-label', `Thinking ${level}`);
        this.piThinkingBtn.classList.remove('hidden');
    }

    _cyclePiThinking() {
        const tab = this.getActiveTab();
        if (!tab || (tab.coder !== 'pi' && tab.coder !== 'pi-rpc')) return;
        if (!this._piThinkingLevels) this._piThinkingLevels = new Map();
        if (tab.coder === 'pi') {
            if (tab.isDead || !tab.ws || tab.ws.readyState === 3) return;
            if (this._piBridgeThinkingEligible(tab)) {
                this._cyclePiBridgeThinking(tab);
            } else {
                this._forwardNativeThinkingCycle(tab);
            }
            return;
        }
        // pi-rpc: cycle only among Pi-advertised levels
        if (this._piRpcThinkingPending) return;
        if (!this._piAvailableThinking) this._piAvailableThinking = new Map();
        const cached = this._piAvailableThinking.get(tab.paneId);
        if (!cached || !Array.isArray(cached) || cached.length === 0) {
            let p;
            try {
                p = rpcChatThinkingLevels(tab.paneId);
            } catch (err) {
                p = Promise.reject(err);
            }
            Promise.resolve(p)
                .then((levels) => {
                    if (!Array.isArray(levels) || levels.length === 0)
                        throw new Error('No Pi thinking levels available');
                    if (!this._piAvailableThinking)
                        this._piAvailableThinking = new Map();
                    this._piAvailableThinking.set(tab.paneId, [...levels]);
                    this._cyclePiThinkingWithLevels(tab, [...levels]);
                })
                .catch((err) => this._piRpcError(err, 'Pi thinking'));
            return;
        }
        this._cyclePiThinkingWithLevels(tab, cached);
    }

    _cyclePiThinkingWithLevels(tab, levels) {
        // Build normalized -> original mapping so we send exactly what Pi advertised
        const normToOriginal = new Map();
        for (const lv of levels) {
            if (typeof lv !== 'string') continue;
            const n = normalizeThinkingLevel(lv);
            if (!normToOriginal.has(n)) normToOriginal.set(n, lv);
        }
        // Preserve PI_THINKING_ORDER but filter to available
        const filteredNorm = PI_THINKING_ORDER.filter((n) =>
            normToOriginal.has(n),
        );
        // Fallback to raw levels if none matched order (e.g. custom names)
        const cycleNorm =
            filteredNorm.length > 0
                ? filteredNorm
                : levels.map((l) => normalizeThinkingLevel(l));
        const cycleOriginal = cycleNorm.map((n) => normToOriginal.get(n) ?? n);
        let cur = 'off';
        const raw = getPiRpcStatus(tab.paneId);
        const fmt = raw ? formatPiRpcStatus(raw) : null;
        const rawLevel = raw?.thinking ?? fmt?.thinking ?? '';
        if (rawLevel && rawLevel !== '—') cur = String(rawLevel);
        else cur = this._piThinkingLevels?.get(tab.paneId) || 'off';
        const curNorm = normalizeThinkingLevel(cur);
        let idx = cycleNorm.indexOf(curNorm);
        // If current not in cycle (e.g. stale), start before first
        if (idx === -1) idx = cycleNorm.indexOf('off');
        if (idx === -1) idx = -1;
        const nextIdx = (idx + 1) % cycleNorm.length;
        const nextNorm = cycleNorm[nextIdx];
        const next = cycleOriginal[nextIdx] ?? nextNorm;
        if (this._piRpcThinkingPending) return;
        const op = { paneId: tab.paneId, level: next };
        this._piRpcThinkingPending = op;
        this._updatePiThinkingButton();
        this.renderPresets('pi-rpc');
        let res;
        try {
            res = rpcChatSetThinking(tab.paneId, next);
        } catch (err) {
            res = Promise.reject(err);
        }
        Promise.resolve(res)
            .then(() => {
                if (this._piRpcThinkingPending === op)
                    this._piRpcThinkingPending = null;
                if (!this._piThinkingLevels) this._piThinkingLevels = new Map();
                this._piThinkingLevels.set(tab.paneId, next);
                if (this.getActiveTab()?.paneId === tab.paneId) {
                    this.renderPresets('pi-rpc');
                    this._updatePiThinkingButton();
                    this.renderPiRpcStatusBar();
                }
            })
            .catch((err) => {
                if (this._piRpcThinkingPending === op)
                    this._piRpcThinkingPending = null;
                this._piRpcError(err, 'Pi thinking');
                if (this.getActiveTab()?.paneId === tab.paneId)
                    this._updatePiThinkingButton();
            });
    }

    _closePiSubagentViewerIfOpen() {
        const tab = this.getActiveTab();
        if (tab?.coder !== 'pi-rpc') return false;
        return closePiSubagentViewer(tab.paneId);
    }

    _closePiRpcDropups(clear = false) {
        let changed = false;
        for (const id of [
            'pi-rpc-model-dropup',
            'pi-rpc-thinking-dropup',
            'pi-rpc-skills-dropup',
        ]) {
            const dropup = document.getElementById(id);
            if (!dropup) continue;
            if (!dropup.classList.contains('hidden')) changed = true;
            dropup.classList.add('hidden');
            if (clear) dropup.replaceChildren();
        }
        return changed;
    }

    _interruptActivePiRpc() {
        const tab = this.getActiveTab();
        if (tab?.coder !== 'pi-rpc') return false;
        const controls = this._piRpcControlsFor(tab);
        if (!controls.ready || controls.exited || !controls.busy) return false;
        void rpcChatInterrupt(tab.paneId)
            .then((result) => this._restoreInterruptedPrompt(tab, result))
            .catch((error) => this._piRpcError(error, 'Pi interrupt'));
        return true;
    }

    // _restoreInterruptedPrompt puts the interrupted turn's prompt texts back
    // into the composer after a successful abort, mirroring pi's TUI
    // restoreQueuedMessagesToEditor. `result.restored` is captured by the
    // chat controller before the abort request (its optimistic state is
    // cleared by the busy=false event first). The user may have switched
    // tabs while the abort was in flight: park the text on the tab's draft
    // instead of touching the shared textarea.
    _restoreInterruptedPrompt(tab, result) {
        const texts = Array.isArray(result?.restored)
            ? result.restored.filter(
                  (text) => typeof text === 'string' && text.trim() !== '',
              )
            : [];
        if (texts.length === 0) return;
        const restored = texts.join('\n\n');
        if (this.getActiveTab()?.paneId !== tab.paneId) {
            tab.draft = tab.draft?.trim()
                ? `${restored}\n\n${tab.draft}`
                : restored;
            return;
        }
        const draft = this.inputTextArea.value;
        this.inputTextArea.value = draft.trim()
            ? `${restored}\n\n${draft}`
            : restored;
        this.lastInputValue = this.inputTextArea.value;
        this._historyCursor = -1;
        this._historyPreCycleValue = undefined;
        this._resetPiRecall({ flush: true });
        tab.chatHistoryCursor = -1;
        tab.chatHistoryPreCycleValue = undefined;
        this.adjustInputHeight();
        this.inputTextArea.focus({ preventScroll: true });
        this._placeCursorAtEnd();
        if (texts.length > 1) {
            // Pi keeps its own steering queue across aborts (no RPC clear op
            // exists), so a verbatim resend would deliver the steers twice.
            this.app.showToast(
                `Pi kept ${texts.length - 1} queued steering message${
                    texts.length > 2 ? 's' : ''
                }; edit before resending to avoid duplicates`,
                { type: 'info', title: 'Pi interrupt' },
            );
        }
    }

    _handlePiRpcEscape(e) {
        if (e.isComposing) return true;
        if (this._closePiSubagentViewerIfOpen()) {
            e.preventDefault();
            e.stopPropagation();
            return true;
        }
        if (this._closePiRpcDropups()) {
            e.preventDefault();
            e.stopPropagation();
            return true;
        }
        if (this._interruptActivePiRpc()) {
            e.preventDefault();
            e.stopPropagation();
            return true;
        }
        return false;
    }

    _handlePiRpcKeydown(e) {
        if (e.isComposing) return;
        if (e.key !== '/') return;
        if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        const dropup = document.getElementById('pi-rpc-model-dropup');
        if (!dropup || dropup.classList.contains('hidden')) return;
        if (
            e.target instanceof Element &&
            e.target.closest('input, textarea, select, [contenteditable]')
        )
            return;
        e.preventDefault();
        dropup.querySelector('.pi-rpc-model-search')?.focus();
    }

    _piRpcControlsFor(tab) {
        const state = tab ? getPiRpcControls(tab.paneId) : null;
        return {
            ready: state?.ready === true,
            exited: state?.exited === true,
            busy: state?.busy === true,
            queueDepth:
                Number.isFinite(state?.queueDepth) && state.queueDepth >= 0
                    ? Math.trunc(state.queueDepth)
                    : 0,
            hasTranscript: state?.hasTranscript === true,
            model: typeof state?.model === 'string' ? state.model : '',
            thinking: typeof state?.thinking === 'string' ? state.thinking : '',
        };
    }

    // Pi PTY tabs share the Pi RPC model picker: their current model is
    // the bridge snapshot, not RPC controls. Pi RPC tabs are unchanged.
    _piModelStateFor(tab) {
        if (tab?.coder === 'pi')
            return { model: tab.piBridge?.model || '' };
        return this._piRpcControlsFor(tab);
    }

    // A cancelled or rejected Clear keeps the existing resume path; only
    // an accepted reset drops it, together with the per-chat history.
    _onPiRpcResetResult(paneId, data) {
        if (data?.cancelled === true) return;
        // A fresh session has no per-chat history.
        const resetTab = this.tabs.get(paneId);
        if (resetTab) {
            resetTab.promptHistory = [];
            resetTab.chatHistoryCursor = -1;
            resetTab.chatHistoryPreCycleValue = undefined;
            resetTab.sessionPath = null;
        }
        this.savePiRpcTabs();
    }

    _piRpcError(error, title = 'Pi RPC') {
        const message =
            error instanceof Error
                ? error.message
                : String(error ?? 'Control failed');
        if (this.app && typeof this.app.showToast === 'function') {
            this.app.showToast(message, { type: 'error', title });
        } else {
            console.error(`[${title}]`, message);
        }
    }

    _setPiRpcDropupButtonsDisabled(dropup, disabled) {
        for (const button of dropup.querySelectorAll('button'))
            button.disabled = disabled;
    }

    _renderPiRpcModelsDropup(preserve = false) {
        const dropup = document.getElementById('pi-rpc-model-dropup');
        const activeTab = this.getActiveTab();
        if (
            !dropup ||
            !activeTab ||
            (activeTab.coder !== 'pi-rpc' && activeTab.coder !== 'pi')
        )
            return;
        if (activeTab.coder === 'pi' && !this._piBridgeModelsEligible(activeTab)) {
            this._closePiRpcDropups(true);
            return;
        }
        const paneId = activeTab.paneId;
        const request = ++this._piRpcMenuRequest;
        const state = this._piModelStateFor(activeTab);
        if (!preserve) {
            this._piRpcModelQuery = '';
            this._piRpcModels = null;
            this._piRpcModelExpandedGroup = null;
            this._piRpcModelAutoOpened = false;
            this._piBridgeModelsTruncated = false;
            this._piBridgeModelsUnavailable = false;
            const sticky = document.createElement('div');
            sticky.className = 'pi-rpc-model-sticky';
            const header = document.createElement('div');
            header.className = 'dropup-header';
            header.textContent = `Model · ${state.model || '—'}`;
            const search = document.createElement('input');
            search.type = 'search';
            search.className = 'pi-rpc-model-search';
            search.setAttribute('aria-label', 'Filter Pi models');
            search.placeholder = 'Filter models…';
            search.addEventListener('input', (event) => {
                if (event.isComposing) return;
                if (
                    typeof event.inputType === 'string' &&
                    event.inputType.startsWith('insertComposition')
                )
                    return;
                this._piRpcModelQuery = search.value.toLowerCase();
                this._buildPiRpcModelList();
            });
            search.addEventListener('compositionend', () => {
                this._piRpcModelQuery = search.value.toLowerCase();
                this._buildPiRpcModelList();
            });
            search.addEventListener('keydown', (event) => {
                if (event.isComposing) return;
                if (event.key === 'Escape' && search.value !== '') {
                    search.value = '';
                    this._piRpcModelQuery = '';
                    this._buildPiRpcModelList();
                    event.stopPropagation();
                }
            });
            sticky.append(header, search);
            const listContainer = document.createElement('div');
            listContainer.className = 'pi-rpc-model-list-container';
            dropup.replaceChildren(sticky, listContainer);
        } else {
            const header = dropup.querySelector(
                '.pi-rpc-model-sticky .dropup-header',
            );
            if (header) header.textContent = `Model · ${state.model || '—'}`;
        }
        const listContainer = dropup.querySelector(
            '.pi-rpc-model-list-container',
        );
        if (!listContainer) return;
        // Cache first: the menu never waits for the catalog. A cached list
        // renders immediately and the refresh replaces it in place.
        this._piRpcModelsNote = null;
        const cached = this._loadPiRpcModelCache(activeTab.coder, paneId);
        const loading = document.createElement('div');
        loading.className = 'dropup-row pi-rpc-dropup-message';
        if (cached) {
            this._piRpcModels = cached.models;
            this._piBridgeModelsTruncated = cached.truncated === true;
            this._buildPiRpcModelList();
        } else {
            loading.textContent = 'Loading Pi models…';
            listContainer.replaceChildren(loading);
        }

        let requestResult;
        try {
            // Opening during a pick would read a catalog from before that
            // pick and move the active row backwards, so the retained rows
            // stand until the pick settles and repaints the presets.
            requestResult = this._piRpcModelInflight?.has(paneId)
                ? null
                : activeTab.coder === 'pi'
                  ? this._piBridgeModelsFetch(paneId)
                  : rpcChatModels(paneId);
        } catch (error) {
            this._piRpcModelsNote = `Could not refresh: ${
                error instanceof Error ? error.message : String(error)
            }`;
            this._buildPiRpcModelList();
            return;
        }
        if (requestResult === null) return;
        Promise.resolve(requestResult)
            .then((result) => {
                if (
                    request !== this._piRpcMenuRequest ||
                    this.getActiveTab()?.paneId !== paneId ||
                    (activeTab.coder === 'pi' &&
                        !this._piBridgeModelsEligible(activeTab))
                )
                    return;
                if (activeTab.coder === 'pi') {
                    const bridge =
                        result && typeof result === 'object' ? result : {};
                    const unavailable = bridge.unavailable === true;
                    const rows = Array.isArray(bridge.models)
                        ? bridge.models
                        : [];
                    // `unavailable` means the registry read failed or the
                    // answer was too large: that is not proof the last good
                    // catalog is empty, so the retained rows stay. A
                    // successful empty answer is proof, and clears them.
                    if (unavailable && this._piRpcModels?.length) {
                        this._piBridgeModelsTruncated =
                            bridge.truncated === true;
                        this._piBridgeModelsUnavailable = true;
                        this._piRpcModelsNote = 'Pi model list unavailable';
                        this._buildPiRpcModelList();
                        return;
                    }
                    this._piBridgeModelsTruncated =
                        bridge.truncated === true;
                    this._piBridgeModelsUnavailable = unavailable;
                    this._piRpcModels = rows;
                } else {
                    this._piRpcModels = Array.isArray(result) ? result : [];
                }
                this._piRpcModelsNote = null;
                this._savePiRpcModelCache(
                    activeTab.coder,
                    paneId,
                    this._piRpcModels,
                );
                this._buildPiRpcModelList();
            })
            .catch((error) => {
                if (
                    request !== this._piRpcMenuRequest ||
                    this.getActiveTab()?.paneId !== paneId ||
                    (activeTab.coder === 'pi' &&
                        !this._piBridgeModelsEligible(activeTab))
                )
                    return;
                // Keep whatever is rendered. A failed refresh is a note,
                // never a menu that empties itself.
                this._piRpcModelsNote = `Could not refresh: ${
                    error instanceof Error ? error.message : String(error)
                }`;
                this._buildPiRpcModelList();
                this._piRpcError(error, 'Pi models');
            });
    }

    // One setter per pane at a time. A pick made while one is in flight is
    // kept per pane as the newest and runs after it, so the last click is the
    // one that lands last instead of two requests racing each other. Picks in
    // one pane never block or displace another pane's.
    _setPiRpcModel(paneId, coder, provider, modelId) {
        if (!this._piRpcModelInflight) this._piRpcModelInflight = new Map();
        if (!this._piRpcModelNextByPane)
            this._piRpcModelNextByPane = new Map();
        if (this._piRpcModelInflight.has(paneId)) {
            this._piRpcModelNextByPane.set(paneId, {
                paneId,
                coder,
                provider,
                modelId,
            });
            return;
        }
        const operation = { paneId, provider, modelId };
        this._piRpcModelInflight.set(paneId, operation);
        this._piRpcModelPending = operation;
        let setterResult;
        try {
            setterResult =
                coder === 'pi'
                    ? this._piBridgeModelSwitch(paneId, provider, modelId)
                    : rpcChatSetModel(paneId, provider, modelId);
        } catch (error) {
            setterResult = Promise.reject(error);
        }
        const settle = (error) => {
            // A disconnect or a newer owner cleared this pane's slot: this
            // reply is stale, so it reports nothing and starts nobody.
            if (this._piRpcModelInflight?.get(paneId) !== operation) return;
            this._piRpcModelInflight.delete(paneId);
            if (this._piRpcModelPending === operation)
                this._piRpcModelPending = null;
            if (error) {
                this._piRpcError(error, 'Pi model');
            } else {
                if (coder === 'pi-rpc')
                    this._piAvailableThinking?.delete(paneId);
                if (this.getActiveTab()?.paneId === paneId)
                    this.renderPresets(coder);
            }
            this._flushPiRpcModelNext(paneId);
        };
        Promise.resolve(setterResult).then(
            () => settle(null),
            (error) => settle(error),
        );
    }

    // A pick that never left the browser is still the user's latest choice, so
    // it waits here until its pane can accept it again instead of being
    // deleted with the failed request.
    _flushPiRpcModelNext(paneId) {
        if (this._piRpcModelInflight?.has(paneId)) return;
        const next = this._piRpcModelNextByPane?.get(paneId);
        if (!next) return;
        const tab = this.tabs?.get(paneId);
        if (!tab) {
            this._piRpcModelNextByPane.delete(paneId);
            return;
        }
        if (tab.coder === 'pi') {
            if (!this._piBridgeModelsEligible(tab)) return;
        } else if (tab.coder !== 'pi-rpc') {
            this._piRpcModelNextByPane.delete(paneId);
            return;
        }
        this._piRpcModelNextByPane.delete(paneId);
        this._setPiRpcModel(
            next.paneId,
            next.coder,
            next.provider,
            next.modelId,
        );
    }

    // The outcome of a written request is unknown once its pane loses the
    // bridge: drop the slot so a late reply cannot speak for a dead pane. The
    // never-sent queue is untouched and flushes when the pane returns.
    _dropPiRpcModelInflight(paneId) {
        this._piRpcModelInflight?.delete(paneId);
        if (this._piRpcModelPending?.paneId === paneId)
            this._piRpcModelPending = null;
    }

    // Full teardown: the pane is gone, so its queued pick has no future owner.
    _clearPiRpcModelPending(paneId) {
        this._dropPiRpcModelInflight(paneId);
        this._piRpcModelNextByPane?.delete(paneId);
    }

    _piRpcModelCacheKey(coder, paneId) {
        // Catalogs are session-scoped (a scoped model list belongs to one
        // pane), so the key carries the pane or another pane's rows would
        // render as this one's.
        return `phi.piRpc.models.${coder}:${paneId ?? ''}`;
    }

    // Only plain rows leave here: a corrupt cached entry must not reach the
    // DOM as an object that throws on string conversion.
    _cleanPiRpcModelRows(models) {
        if (!Array.isArray(models)) return [];
        const rows = [];
        for (const model of models) {
            if (!model || typeof model.provider !== 'string' || !model.provider)
                continue;
            if (typeof model.id !== 'string' || !model.id) continue;
            const row = { provider: model.provider, id: model.id };
            if (typeof model.name === 'string' && model.name)
                row.name = model.name;
            rows.push(row);
        }
        return rows;
    }

    // The last good catalog lives in memory first: localStorage can refuse a
    // write (quota, private mode) and the menu must still open from it. A
    // stored empty list is a real answer and is kept as one.
    _loadPiRpcModelCache(coder, paneId) {
        const key = this._piRpcModelCacheKey(coder, paneId);
        const memory = this._piRpcModelMemory?.get(key);
        if (memory) return memory;
        try {
            const raw = window.localStorage?.getItem(key);
            if (typeof raw !== 'string' || !raw) return null;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed?.models)) return null;
            const entry = {
                models: this._cleanPiRpcModelRows(parsed.models),
                truncated: parsed.truncated === true,
            };
            if (!this._piRpcModelMemory) this._piRpcModelMemory = new Map();
            this._piRpcModelMemory.set(key, entry);
            return entry;
        } catch (_error) {
            return null;
        }
    }

    // Catalogs are session-scoped, so a deleted pane's entry has no future
    // owner and is not kept alive by the memory copy or by storage.
    _forgetPiRpcModelCache(coder, paneId) {
        const key = this._piRpcModelCacheKey(coder, paneId);
        this._piRpcModelMemory?.delete(key);
        try {
            window.localStorage?.removeItem(key);
        } catch (_error) {
            /* storage unavailable */
        }
    }

    // A pane id changes when its session is replaced, so persisted catalogs
    // would otherwise accumulate until they use up the quota every other
    // write needs. The oldest are dropped first.
    _prunePiRpcModelCaches(keep = 20) {
        try {
            const storage = window.localStorage;
            if (!storage) return;
            const entries = [];
            for (let index = 0; index < storage.length; index++) {
                const key = storage.key(index);
                if (
                    typeof key !== 'string' ||
                    !key.startsWith('phi.piRpc.models.')
                )
                    continue;
                let at = 0;
                try {
                    at = Number(JSON.parse(storage.getItem(key))?.at) || 0;
                } catch (_error) {
                    at = 0;
                }
                entries.push({ key, at });
            }
            if (entries.length <= keep) return;
            entries.sort((left, right) => left.at - right.at);
            for (const entry of entries.slice(0, entries.length - keep)) {
                storage.removeItem(entry.key);
            }
        } catch (_error) {
            // Storage that throws on access (restricted browsing, quota
            // probing) must not turn a successful refresh into an error: the
            // memory copy already serves this session.
        }
    }

    _savePiRpcModelCache(coder, paneId, models) {
        const entry = {
            models: this._cleanPiRpcModelRows(models),
            truncated: this._piBridgeModelsTruncated === true,
        };
        const key = this._piRpcModelCacheKey(coder, paneId);
        if (!this._piRpcModelMemory) this._piRpcModelMemory = new Map();
        this._piRpcModelMemory.set(key, entry);
        try {
            window.localStorage?.setItem(
                key,
                JSON.stringify({
                    at: Date.now(),
                    truncated: entry.truncated,
                    models: entry.models,
                }),
            );
        } catch (_error) {
            // localStorage may be unavailable; the memory copy still serves
            // this session.
        }
        this._prunePiRpcModelCaches();
    }

    _buildPiRpcModelList() {
        const dropup = document.getElementById('pi-rpc-model-dropup');
        const activeTab = this.getActiveTab();
        if (
            !dropup ||
            !activeTab ||
            (activeTab.coder !== 'pi-rpc' && activeTab.coder !== 'pi') ||
            (activeTab.coder === 'pi' && !this._piBridgeModelsEligible(activeTab))
        )
            return;
        const listContainer = dropup.querySelector(
            '.pi-rpc-model-list-container',
        );
        if (!listContainer) return;
        if (!Array.isArray(this._piRpcModels)) {
            // No list yet: a failed load still says so instead of leaving the
            // loading row up forever.
            if (!this._piRpcModelsNote) return;
            const note = document.createElement('div');
            note.className = 'dropup-row pi-rpc-dropup-message';
            note.textContent = this._piRpcModelsNote;
            listContainer.replaceChildren(note);
            return;
        }
        const state = this._piModelStateFor(activeTab);
        const paneId = activeTab.paneId;
        const query = this._piRpcModelQuery;
        const models = this._cleanPiRpcModelRows(this._piRpcModels);
        if (models.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'dropup-row pi-rpc-dropup-message';
            empty.textContent =
                activeTab.coder === 'pi' && this._piBridgeModelsUnavailable
                    ? 'Pi model list unavailable'
                    : 'No Pi models available';
            listContainer.replaceChildren(empty);
            return;
        }
        this._loadPiRpcFavoritesIfNeeded();
        const favoriteKey = (model) => `${model.provider}/${model.id}`;
        const favorites = this._piRpcFavorites || new Set();
        const favoriteRows = models.filter((m) =>
            favorites.has(favoriteKey(m)),
        );
        const restRows = models.filter((m) => !favorites.has(favoriteKey(m)));
        const matches = (model) => {
            const haystack = (
                model.provider +
                ' ' +
                model.id +
                ' ' +
                (model.name || '')
            ).toLowerCase();
            return query === '' || haystack.includes(query);
        };
        let activeModel = null;
        for (const model of models) {
            // Bridge snapshots name provider/id; RPC controls name id.
            if (
                activeTab.coder === 'pi'
                    ? `${model.provider}/${model.id}` === state.model
                    : model.id === state.model
            ) {
                activeModel = model;
                break;
            }
        }
        if (!activeModel && activeTab.coder === 'pi-rpc') {
            for (const model of models) {
                if (model.name === state.model) {
                    activeModel = model;
                    break;
                }
            }
        }
        const renderRow = (model) => {
            const row = document.createElement('li');
            row.className = 'dropup-row pi-rpc-model-row';
            if (model === activeModel) row.classList.add('is-active');
            const isFavorite = favorites.has(favoriteKey(model));
            const star = document.createElement('button');
            star.type = 'button';
            star.className = `pi-rpc-model-star${
                isFavorite ? ' is-favorite' : ''
            }`;
            star.textContent = isFavorite ? '★' : '☆';
            star.setAttribute(
                'aria-label',
                isFavorite ? 'Remove from Favorites' : 'Add to Favorites',
            );
            star.setAttribute('aria-pressed', String(isFavorite));
            star.title = isFavorite
                ? 'Remove from Favorites'
                : 'Add to Favorites';
            star.addEventListener('click', (event) => {
                event.stopPropagation();
                this._togglePiRpcFavorite(model);
            });
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'dropup-model-btn';
            button.textContent = model.name || model.id;
            button.title = `${model.provider}/${model.id}`;
            // A pick is local feedback: the row stays enabled while its
            // request is in flight, and the newest pick wins.
            button.disabled = false;
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                if (
                    activeTab.coder === 'pi' &&
                    (this.getActiveTab() !== activeTab ||
                        !this._piBridgeModelsEligible(activeTab) ||
                        !dropup.contains(button))
                )
                    return;
                // The pick is local feedback: close the menu now and let the
                // state event (or the error toast) reconcile it. A slow link
                // must not freeze the menu for the length of a round trip.
                this._closePiRpcDropups(true);
                this._setPiRpcModel(
                    paneId,
                    activeTab.coder,
                    model.provider,
                    model.id,
                );
            });
            const meta = document.createElement('span');
            meta.className = 'pi-rpc-dropup-meta';
            meta.textContent = `${model.provider}/${model.id}`;
            row.append(star, button, meta);
            return row;
        };
        const renderGroup = (group, firstMatchGroup) => {
            const groupMatches = group.rows.filter(matches);
            const groupEl = document.createElement('div');
            groupEl.className = 'pi-rpc-model-group';
            if (groupMatches.length === 0) {
                groupEl.classList.add('is-empty');
            }
            const listId = `pi-rpc-model-list-${group.id}`;
            const expanded =
                group.alwaysExpanded ||
                (query !== '' && group.id === firstMatchGroup) ||
                (!group.alwaysExpanded &&
                    this._piRpcModelExpandedGroup === group.id);
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'pi-rpc-model-group-toggle';
            toggle.setAttribute('aria-controls', listId);
            toggle.setAttribute('aria-expanded', String(expanded));
            if (group.alwaysExpanded) {
                toggle.disabled = true;
                toggle.setAttribute('aria-disabled', 'true');
            } else {
                toggle.disabled = false;
                toggle.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this._piRpcModelExpandedGroup =
                        this._piRpcModelExpandedGroup === group.id
                            ? null
                            : group.id;
                    this._buildPiRpcModelList();
                });
            }
            const label = document.createElement('span');
            label.className = 'pi-rpc-model-group-label';
            label.textContent = `${group.label} (${group.rows.length})`;
            toggle.appendChild(label);
            const list = document.createElement('ul');
            list.id = listId;
            list.className = 'pi-rpc-model-list';
            if (!expanded) list.classList.add('is-collapsed');
            for (const model of groupMatches) {
                list.appendChild(renderRow(model));
            }
            groupEl.append(toggle, list);
            return { node: groupEl, matchCount: groupMatches.length };
        };
        const sections = [];
        if (favoriteRows.length > 0) {
            sections.push({
                id: 'favorites',
                label: 'Favorites',
                rows: favoriteRows,
                alwaysExpanded: true,
            });
        }
        // Group the remaining models by provider in first-seen order, so
        // the first screen shows provider sections instead of a flat list.
        const providerSource = favoriteRows.length > 0 ? restRows : models;
        const groupByProvider = new Map();
        for (const model of providerSource) {
            let rows = groupByProvider.get(model.provider);
            if (!rows) {
                rows = [];
                groupByProvider.set(model.provider, rows);
            }
            rows.push(model);
        }
        for (const [provider, rows] of groupByProvider) {
            sections.push({
                id: `provider:${provider.replace(/\s+/g, '-')}`,
                label: provider,
                rows,
                alwaysExpanded: false,
            });
        }
        // Auto-open the active model's provider group the first time the
        // picker renders with no favorites (first provider otherwise), so
        // the user does not have to click to see anything.
        if (
            favoriteRows.length === 0 &&
            !this._piRpcModelAutoOpened &&
            sections.length > 0
        ) {
            this._piRpcModelAutoOpened = true;
            let openId = sections[0].id;
            if (activeModel) {
                const hit = sections.find(
                    (section) => section.label === activeModel.provider,
                );
                if (hit) openId = hit.id;
            }
            this._piRpcModelExpandedGroup = openId;
        }
        // Auto-expand the first section with a hit while the user is
        // searching. The user's manual expansion choice is overridden;
        // manual state returns when the query clears because
        // _piRpcModelExpandedGroup is never mutated here.
        const firstMatchGroup =
            query !== ''
                ? (sections.find((g) => g.rows.some(matches))?.id ?? null)
                : null;
        const nodes = [];
        let totalMatches = 0;
        const notes = [];
        for (const section of sections) {
            const { node, matchCount } = renderGroup(section, firstMatchGroup);
            totalMatches += matchCount;
            nodes.push(node);
        }
        if (query !== '' && totalMatches === 0) {
            const noMatch = document.createElement('div');
            noMatch.className = 'dropup-row pi-rpc-model-no-match';
            noMatch.textContent = 'No matches';
            listContainer.replaceChildren(...nodes, noMatch);
            return;
        }
        if (activeTab.coder === 'pi' && this._piBridgeModelsTruncated)
            notes.push('Partial model list');
        if (this._piRpcModelsNote) notes.push(this._piRpcModelsNote);
        for (const text of notes) {
            const note = document.createElement('div');
            note.className = 'dropup-row pi-rpc-dropup-message';
            note.textContent = text;
            nodes.push(note);
        }
        listContainer.replaceChildren(...nodes);
    }

    _loadPiRpcFavoritesIfNeeded() {
        if (this._piRpcFavoritesLoaded) return;
        this._piRpcFavoritesLoaded = true;
        let parsed = null;
        try {
            const raw = window.localStorage?.getItem('phi.piRpc.favorites');
            if (typeof raw === 'string' && raw) {
                const v = JSON.parse(raw);
                if (Array.isArray(v))
                    parsed = v.filter((s) => typeof s === 'string');
            }
        } catch (_error) {
            // ignore — fall through to seed from config
        }
        if (parsed && parsed.length > 0) {
            this._piRpcFavorites = new Set(parsed);
            return;
        }
        // One-time seed from model_presets.pi (legacy config). After this,
        // localStorage is the source of truth.
        const configured = this.app?.modelPresets?.pi;
        if (Array.isArray(configured) && configured.length > 0) {
            const seeded = configured
                .map((s) => String(s).trim())
                .filter(Boolean);
            this._piRpcFavorites = new Set(seeded);
            try {
                window.localStorage?.setItem(
                    'phi.piRpc.favorites',
                    JSON.stringify(seeded),
                );
            } catch (_error) {
                // localStorage may be unavailable; in-memory copy is enough
                // for this session.
            }
            return;
        }
        this._piRpcFavorites = new Set();
    }

    _togglePiRpcFavorite(model) {
        this._loadPiRpcFavoritesIfNeeded();
        const key = `${model.provider}/${model.id}`;
        if (this._piRpcFavorites.has(key)) {
            this._piRpcFavorites.delete(key);
        } else {
            this._piRpcFavorites.add(key);
        }
        try {
            window.localStorage?.setItem(
                'phi.piRpc.favorites',
                JSON.stringify([...this._piRpcFavorites]),
            );
        } catch (_error) {
            // localStorage may be unavailable; UI still updates this session.
        }
        this._buildPiRpcModelList();
    }

    // Bridge catalog fetch for Pi PTY tabs. Rows arrive mapped to
    // {provider, id} so rendering, favorites, and search stay shared
    // with Pi RPC. Flags ride along so the caller assigns them inside
    // the staleness fence; they drive the empty copy and the footer.
    async _piBridgeModelsFetch(paneId) {
        const controller = new AbortController();
        // Bound the browser too, but generously: the caller renders from
        // local state, so a slow link only delays the refresh.
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const res = await fetch(
                `/api/pi-bridge/models?pane=${encodeURIComponent(paneId)}`,
                { signal: controller.signal },
            );
            if (!res.ok)
                throw new Error(`Pi models unavailable (${res.status})`);
            const body = await res.json();
            return {
                models: Array.isArray(body.models) ? body.models : [],
                truncated: body.truncated === true,
                unavailable: body.unavailable === true,
            };
        } catch (error) {
            if (error?.name === 'AbortError')
                throw new Error('Pi models unavailable (request timed out)');
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    // Bridge model switch for Pi PTY tabs. A refused switch surfaces
    // its reason; a failed round trip is explicitly unknown, never a
    // guessed failure, since the switch may still have landed.
    async _piBridgeModelSwitch(paneId, provider, modelId) {
        const controller = new AbortController();
        // Bound the browser too, but generously: the caller renders from
        // local state, so a slow link only delays the refresh.
        const timer = setTimeout(() => controller.abort(), 15000);
        let body;
        try {
            const res = await fetch('/api/pi-bridge/model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pane: paneId,
                    provider,
                    model: modelId,
                }),
                signal: controller.signal,
            });
            if (!res.ok) throw new Error('unknown');
            body = await res.json();
        } catch {
            throw new Error('unknown — reopen the picker');
        } finally {
            clearTimeout(timer);
        }
        if (body.ok === true) return;
        if (body.reason === 'no-auth')
            throw new Error(
                'Switch refused: provider has no credentials (no-auth)',
            );
        if (body.reason === 'unknown-model')
            throw new Error(
                'Switch refused: model is not selectable (unknown-model)',
            );
        // ok=false with an empty reason means the attempt errored
        // and its outcome is unknown, like a failed round trip;
        // anything else is an unexpected refusal shape.
        if (body.reason === '')
            throw new Error('unknown — reopen the picker');
        throw new Error('Switch failed');
    }

    // Bridge skill list for Pi PTY tabs. The list is fetched when the
    // picker opens, like the model catalog: no per-pane cache, so a
    // session that gained or lost a skill shows the current set.
    async _piBridgeSkillsFetch(paneId) {
        const controller = new AbortController();
        // Bound the browser too: an HTTP request can stall before reaching Phi.
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(
                `/api/pi-bridge/skills?pane=${encodeURIComponent(paneId)}`,
                { signal: controller.signal },
            );
            if (!res.ok)
                throw new Error(`Pi skills unavailable (${res.status})`);
            const body = await res.json();
            return {
                skills: Array.isArray(body.skills) ? body.skills : [],
                truncated: body.truncated === true,
                unavailable: body.unavailable === true,
                // The origin of the answer: the peer that served the
                // list. A click must carry it, so the skill can never
                // reach a runtime that replaced this one.
                processId:
                    typeof body.process_id === 'string'
                        ? body.process_id
                        : '',
                generation:
                    typeof body.generation === 'string'
                        ? body.generation
                        : '',
            };
        } catch (error) {
            if (error?.name === 'AbortError')
                throw new Error('Pi skills unavailable (request timed out)');
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    // Bridge skill invocation for Pi PTY tabs. The ack means the
    // request was dispatched to Pi, never that the agent accepted or
    // completed it. A failed round trip is explicitly unknown and is
    // never retried automatically: the skill may still have landed.
    // The origin of the list that produced the row travels with the
    // request, so the bridge can refuse a stale runtime.
    async _piBridgeSkillInvoke(paneId, name, origin) {
        const controller = new AbortController();
        // Bound the browser too: an HTTP request can stall before reaching Phi.
        const timer = setTimeout(() => controller.abort(), 10000);
        let body;
        try {
            const res = await fetch('/api/pi-bridge/skill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pane: paneId,
                    name,
                    process_id: origin.processId,
                    generation: origin.generation,
                }),
                signal: controller.signal,
            });
            if (!res.ok) throw new Error('unknown');
            body = await res.json();
        } catch {
            throw new Error('Skill send outcome unknown — open Pi to check');
        } finally {
            clearTimeout(timer);
        }
        if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean')
            // An ack without a verdict does not say whether the skill
            // landed, so the outcome is unknown.
            throw new Error('Skill send outcome unknown — open Pi to check');
        if (body.ok === true) return;
        const reason = typeof body.reason === 'string' ? body.reason : '';
        if (reason === 'unknown-skill')
            throw new Error('Skill refused: unknown skill (unknown-skill)');
        if (reason === 'unavailable')
            throw new Error('Skill refused: Pi is unavailable (unavailable)');
        if (reason === '')
            throw new Error('Skill send outcome unknown — open Pi to check');
        throw new Error('Skill send failed');
    }

    _renderPiRpcSkillsDropup(preserve = false) {
        const dropup = document.getElementById('pi-rpc-skills-dropup');
        const activeTab = this.getActiveTab();
        if (!dropup || !activeTab || activeTab.coder !== 'pi') return;
        if (!this._piBridgeSkillsEligible(activeTab)) {
            this._closePiRpcDropups(true);
            return;
        }
        const paneId = activeTab.paneId;
        // The list belongs to the runtime that answers it: a replaced
        // peer invalidates the whole picker session.
        const context = this._piBridgeSkillsContextFor(activeTab);
        // The last good answer stays on screen while the picker
        // refreshes: a slow or failed refresh never empties the list.
        const reused = this._piBridgeSkillsReusable(context);
        this._piBridgeSkillsContext = context;
        const request = ++this._piBridgeSkillsRequest;
        if (!preserve) {
            this._piBridgeSkillQuery = '';
            if (!reused) {
                this._piBridgeSkills = null;
                this._piBridgeSkillsTruncated = false;
                this._piBridgeSkillsUnavailable = false;
            }
            const sticky = document.createElement('div');
            sticky.className = 'pi-rpc-model-sticky';
            const header = document.createElement('div');
            header.className = 'dropup-header';
            header.textContent = 'Skills';
            const search = document.createElement('input');
            search.type = 'search';
            search.className = 'pi-rpc-model-search';
            search.setAttribute('aria-label', 'Filter Pi skills');
            search.placeholder = 'Filter skills…';
            search.addEventListener('input', (event) => {
                if (event.isComposing) return;
                if (
                    typeof event.inputType === 'string' &&
                    event.inputType.startsWith('insertComposition')
                )
                    return;
                this._piBridgeSkillQuery = search.value.toLowerCase();
                this._buildPiRpcSkillsList();
            });
            search.addEventListener('compositionend', () => {
                this._piBridgeSkillQuery = search.value.toLowerCase();
                this._buildPiRpcSkillsList();
            });
            search.addEventListener('keydown', (event) => {
                if (event.isComposing) return;
                if (event.key === 'Escape' && search.value !== '') {
                    search.value = '';
                    this._piBridgeSkillQuery = '';
                    this._buildPiRpcSkillsList();
                    event.stopPropagation();
                }
            });
            sticky.append(header, search);
            const listContainer = document.createElement('div');
            listContainer.className = 'pi-rpc-model-list-container';
            dropup.replaceChildren(sticky, listContainer);
        }
        const listContainer = dropup.querySelector(
            '.pi-rpc-model-list-container',
        );
        if (!listContainer) return;
        const loading = document.createElement('div');
        loading.className = 'dropup-row pi-rpc-dropup-message';
        loading.textContent = 'Loading Pi skills…';
        if (reused) {
            // The retained rows are shown at once; the refresh below
            // replaces them in place.
            this._buildPiRpcSkillsList();
        } else {
            listContainer.replaceChildren(loading);
        }

        let requestResult;
        try {
            requestResult = this._piBridgeSkillsFetch(paneId);
        } catch (error) {
            this._piRpcError(error, 'Pi skills');
            loading.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
            return;
        }
        Promise.resolve(requestResult)
            .then((result) => {
                if (
                    request !== this._piBridgeSkillsRequest ||
                    this.getActiveTab()?.paneId !== paneId
                )
                    return;
                const bridge = result && typeof result === 'object' ? result : {};
                // The origin belongs to the runtime that answered.
                context.origin = {
                    processId: bridge.processId || '',
                    generation: bridge.generation || '',
                };
                // The answer is checked against the browser's view: a
                // list from a runtime the browser already left is stale.
                if (!this._piBridgeSkillsContextValid(context)) {
                    this._showPiRpcSkillsMessage(
                        listContainer,
                        'Pi skill list unavailable',
                    );
                    return;
                }
                this._piBridgeSkillsTruncated = bridge.truncated === true;
                this._piBridgeSkillsUnavailable = bridge.unavailable === true;
                // A fresh answer replaces the retained one: the rows are
                // current again.
                this._piBridgeSkillsStale = false;
                this._piBridgeSkills = Array.isArray(bridge.skills)
                    ? bridge.skills
                    : [];
                this._buildPiRpcSkillsList();
            })
            .catch((error) => {
                if (
                    request !== this._piBridgeSkillsRequest ||
                    this.getActiveTab()?.paneId !== paneId ||
                    !this._piBridgeSkillsContextBound(context)
                )
                    return;
                if (!this._piBridgeSkillsContextValid(context)) {
                    // The runtime moved on: the failure belongs to a
                    // runtime the user already left.
                    this._showPiRpcSkillsMessage(
                        listContainer,
                        'Pi skill list unavailable',
                    );
                    return;
                }
                if (reused) {
                    // The list stays: a failed refresh never empties
                    // it. The rows are rebuilt with the note that says
                    // they may be out of date. The note is state, not a
                    // one-off element, so a later filter rebuild keeps
                    // it.
                    this._piBridgeSkillsStale = true;
                    this._buildPiRpcSkillsList();
                    return;
                }
                loading.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
                this._piRpcError(error, 'Pi skills');
            });
    }

    // _showPiRpcSkillsNote keeps the rendered list and adds one short
    // status line. A failed refresh must not empty the list.
    _showPiRpcSkillsNote(listContainer, text) {
        if (!listContainer) return;
        const note = document.createElement('div');
        note.className = 'dropup-row pi-rpc-dropup-message';
        note.textContent = text;
        listContainer.append(note);
    }

    // _piBridgeSkillsReusable reports whether the retained answer can
    // be shown again for this runtime, and hands its origin to the new
    // context. The last good answer stays on screen while the picker
    // refreshes, so a slow or failed refresh never empties the list.
    // A replaced peer, a swapped socket, or a moved generation drops
    // it.
    _piBridgeSkillsReusable(context) {
        const retained = this._piBridgeSkillsContext;
        if (
            !retained ||
            retained.paneId !== context.paneId ||
            !Array.isArray(this._piBridgeSkills) ||
            !this._piBridgeSkillsContextValid(retained)
        )
            return false;
        context.origin = retained.origin;
        return true;
    }

    // _showPiRpcSkillsMessage replaces the picker list with one message
    // row. A stale answer or a failure for a runtime the user already
    // left must not leave the picker on "Loading".
    _showPiRpcSkillsMessage(listContainer, text) {
        if (!listContainer) return;
        const message = document.createElement('div');
        message.className = 'dropup-row pi-rpc-dropup-message';
        message.textContent = text;
        listContainer.replaceChildren(message);
    }

    _buildPiRpcSkillsList() {
        const dropup = document.getElementById('pi-rpc-skills-dropup');
        const activeTab = this.getActiveTab();
        if (!dropup || !activeTab || activeTab.coder !== 'pi') return;
        if (!this._piBridgeSkillsEligible(activeTab)) return;
        const listContainer = dropup.querySelector(
            '.pi-rpc-model-list-container',
        );
        if (!listContainer) return;
        const paneId = activeTab.paneId;
        const query = this._piBridgeSkillQuery;
        // The rows belong to the runtime that produced the list.
        const context = this._piBridgeSkillsContext;
        if (!this._piBridgeSkillsContextValid(context)) return;
        // Only a dispatch that belongs to the runtime which produced
        // this list may lock the rows: an older runtime's request must
        // not disable the current picker.
        const pendingOp = this._piBridgeSkillPending?.get(paneId);
        const pending =
            !!pendingOp &&
            this._piBridgeSkillsOriginMatches(pendingOp, context);
        const skills = (this._piBridgeSkills || []).filter(
            (skill) =>
                skill &&
                typeof skill.name === 'string' &&
                skill.name !== '',
        );
        // Without the answering origin a row cannot be dispatched
        // safely, so the list is unusable rather than dead.
        const origin = context.origin;
        const usable =
            !!origin && origin.processId !== '' && origin.generation !== '';
        if (skills.length === 0 || !usable) {
            const empty = document.createElement('div');
            empty.className = 'dropup-row pi-rpc-dropup-message';
            empty.textContent =
                this._piBridgeSkillsUnavailable || !usable
                    ? 'Pi skill list unavailable'
                    : 'No Pi skills available';
            listContainer.replaceChildren(empty);
            return;
        }
        const matches = (skill) => {
            const haystack =
                skill.name + ' ' + (skill.description || '').toLowerCase();
            return query === '' || haystack.toLowerCase().includes(query);
        };
        const rows = skills.filter(matches).map((skill) => {
            const row = document.createElement('div');
            row.className = 'dropup-row pi-rpc-model-row';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'dropup-model-btn';
            button.textContent = skill.name;
            button.title = skill.description || skill.name;
            button.disabled = pending;
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                // Re-check at the point of use: the peer, the socket, the
                // runtime, or the capability can be gone while the row
                // is on screen.
                if (
                    this.getActiveTab() !== activeTab ||
                    !this._piBridgeSkillsContextValid(context) ||
                    !dropup.contains(button)
                )
                    return;
                const operation = {
                    paneId,
                    name: skill.name,
                    tab: activeTab,
                    socket: activeTab.ws,
                    // The answering runtime owns this dispatch, not the
                    // browser's view of the generation: the view can
                    // lag behind the runtime that served the list.
                    origin: { ...origin },
                };
                this._piBridgeSkillPending.set(paneId, operation);
                this._setPiRpcDropupButtonsDisabled(dropup, true);
                let invokeResult;
                try {
                    invokeResult = this._piBridgeSkillInvoke(
                        paneId,
                        skill.name,
                        origin,
                    );
                } catch (error) {
                    invokeResult = Promise.reject(error);
                }
                Promise.resolve(invokeResult)
                    .then(() => {
                        // A newer dispatch for the same pane keeps the
                        // slot; the settled one never touches it.
                        if (this._piBridgeSkillPending?.get(paneId) === operation)
                            this._piBridgeSkillPending.delete(paneId);
                        // A closed pane reports nothing.
                        if (this.tabs?.get(operation.paneId) !== operation.tab)
                            return;
                        // The dispatch is confirmed whatever happened to
                        // the socket or the runtime meanwhile.
                        if (this.getActiveTab()?.paneId === paneId) {
                            this.app?.showToast?.(
                                `Sent ${skill.name} to Pi`,
                                { type: 'success', title: 'Pi skill' },
                            );
                        }
                        // Only the runtime that received the dispatch
                        // may close the picker; a replacement runtime
                        // keeps its own state.
                        if (
                            this._piBridgeSkillsRuntimeCurrent(operation) &&
                            this.getActiveTab()?.paneId === paneId
                        )
                            this._closePiRpcDropups(true);
                    })
                    .catch((error) => {
                        if (this._piBridgeSkillPending?.get(paneId) === operation)
                            this._piBridgeSkillPending.delete(paneId);
                        // A closed pane reports nothing.
                        if (this.tabs?.get(operation.paneId) !== operation.tab)
                            return;
                        // The dispatch may still have landed: the
                        // outcome is unknown whatever happened to the
                        // socket or the runtime meanwhile, so the user
                        // learns it exactly once and it is never resent.
                        this._piRpcError(error, 'Pi skill');
                        // Only the runtime that received the dispatch
                        // may re-open the picker; a replacement runtime
                        // keeps its own state.
                        const current = this.getActiveTab();
                        if (
                            this._piBridgeSkillsRuntimeCurrent(operation) &&
                            current?.paneId === paneId &&
                            this._piBridgeSkillsEligible(current)
                        )
                            this._renderPiRpcSkillsDropup(true);
                    });
            });
            const meta = document.createElement('span');
            meta.className = 'pi-rpc-dropup-meta';
            meta.textContent = skill.description || '';
            row.append(button, meta);
            return row;
        });
        listContainer.replaceChildren(...rows);
        if (this._piBridgeSkillsTruncated) {
            const footer = document.createElement('div');
            footer.className = 'dropup-row pi-rpc-dropup-message';
            footer.textContent = 'Partial skill list';
            listContainer.append(footer);
        }
        if (this._piBridgeSkillsStale) {
            // The rows are the last known ones. The note belongs to the
            // state, so a filter rebuild keeps it.
            this._showPiRpcSkillsNote(
                listContainer,
                'Refresh failed — showing the last known skills',
            );
        }
    }

    _renderPiRpcThinkingDropup() {
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        const tab = this.getActiveTab();
        const bridgeTab = tab?.coder === 'pi';
        if (
            !dropup ||
            (!bridgeTab && tab?.coder !== 'pi-rpc') ||
            (bridgeTab && !this._piBridgeThinkingEligible(tab))
        )
            return;

        const paneId = tab.paneId;
        const context = bridgeTab ? this._piBridgeThinkingContext(tab) : null;
        const socket = bridgeTab ? tab.ws : null;
        const request = bridgeTab
            ? (this._piBridgeThinkingMenuRequest || 0) + 1
            : ++this._piRpcMenuRequest;
        if (bridgeTab) this._piBridgeThinkingMenuRequest = request;
        const state = bridgeTab ? null : this._piRpcControlsFor(tab);
        const header = document.createElement('div');
        header.className = 'dropup-header';
        header.textContent = `Thinking · ${bridgeTab ? tab.piBridge.thinking_level || '—' : state.thinking || '—'}`;
        const loading = document.createElement('div');
        loading.className = 'dropup-row pi-rpc-dropup-message';
        loading.textContent = 'Loading Pi thinking levels…';
        dropup.replaceChildren(header, loading);

        const current = () =>
            bridgeTab
                ? request === this._piBridgeThinkingMenuRequest &&
                  !dropup.classList.contains('hidden') &&
                  this.getActiveTab() === tab &&
                  this.tabs?.get(paneId) === tab &&
                  tab.ws === socket &&
                  this._piBridgeThinkingEligible(tab) &&
                  (!context || this._piBridgeThinkingContextValid(context))
                : request === this._piRpcMenuRequest &&
                  this.getActiveTab()?.paneId === paneId;
        const offerNativePicker = () => {
            loading.textContent = 'Pi thinking levels unavailable';
            const native = document.createElement('button');
            native.type = 'button';
            native.className = 'dropup-model-btn';
            native.textContent = 'Open native Thinking picker';
            native.addEventListener('click', (event) => {
                event.stopPropagation();
                if (current()) this.sendSlashCommand(tab, '/thinking');
            });
            loading.appendChild(native);
        };
        const showRpcError = (error) => {
            loading.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
            this._piRpcError(error, 'Pi thinking');
        };

        if (bridgeTab && !context) {
            offerNativePicker();
            return;
        }

        let requestResult;
        try {
            requestResult = bridgeTab
                ? this._piBridgeThinkingLevels(paneId)
                : rpcChatThinkingLevels(paneId);
        } catch (error) {
            if (bridgeTab) {
                if (current()) offerNativePicker();
            } else {
                showRpcError(error);
            }
            return;
        }
        Promise.resolve(requestResult)
            .then((result) => {
                if (!current()) return;
                let levels = result;
                if (bridgeTab) {
                    if (!this._piBridgeThinkingOriginMatches(context, result)) {
                        offerNativePicker();
                        return;
                    }
                    levels = result.levels;
                } else {
                    if (!this._piAvailableThinking)
                        this._piAvailableThinking = new Map();
                    if (Array.isArray(levels) && levels.length > 0)
                        this._piAvailableThinking.set(paneId, [...levels]);
                }
                if (!Array.isArray(levels) || levels.length === 0) {
                    if (bridgeTab) {
                        offerNativePicker();
                    } else {
                        loading.textContent = 'No Pi thinking levels available';
                    }
                    return;
                }

                dropup.replaceChildren(header);
                const pending =
                    this._piRpcThinkingPending?.paneId === paneId;
                for (const level of levels) {
                    if (typeof level !== 'string') continue;
                    const row = document.createElement('div');
                    row.className = 'dropup-row';
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'dropup-model-btn';
                    button.textContent = level;
                    button.disabled = pending;
                    button.addEventListener('click', (event) => {
                        event.stopPropagation();
                        if (bridgeTab && !current()) return;
                        const operation = bridgeTab
                            ? { paneId, context, level }
                            : { paneId, level };
                        this._piRpcThinkingPending = operation;
                        if (bridgeTab) this._updatePiThinkingButton();
                        this._setPiRpcDropupButtonsDisabled(dropup, true);
                        let setterResult;
                        try {
                            setterResult = bridgeTab
                                ? this._piBridgeThinkingSet(context, level, result)
                                : rpcChatSetThinking(paneId, level);
                        } catch (error) {
                            setterResult = Promise.reject(error);
                        }
                        Promise.resolve(setterResult)
                            .then(() => {
                                // A superseded operation owns nothing, so it
                                // cannot close or re-render a newer picker.
                                if (
                                    bridgeTab &&
                                    this._piRpcThinkingPending !== operation
                                )
                                    return;
                                if (this._piRpcThinkingPending === operation)
                                    this._piRpcThinkingPending = null;
                                if (bridgeTab) {
                                    if (!this._piBridgeThinkingContextValid(context))
                                        return;
                                    this._updatePiThinkingButton();
                                    if (!dropup.classList.contains('hidden')) {
                                        this._closePiRpcDropups(true);
                                    }
                                } else if (this.getActiveTab()?.paneId === paneId) {
                                    this.renderPresets('pi-rpc');
                                    this._closePiRpcDropups(true);
                                }
                            })
                            .catch((error) => {
                                if (
                                    bridgeTab &&
                                    this._piRpcThinkingPending !== operation
                                )
                                    return;
                                if (this._piRpcThinkingPending === operation)
                                    this._piRpcThinkingPending = null;
                                if (bridgeTab) {
                                    if (!this._piBridgeThinkingContextValid(context))
                                        return;
                                    this._piRpcError(error, 'Pi thinking');
                                    this._updatePiThinkingButton();
                                    this._renderPiRpcThinkingDropup();
                                } else {
                                    this._piRpcError(error, 'Pi thinking');
                                    if (this.getActiveTab()?.paneId === paneId)
                                        this._renderPiRpcThinkingDropup();
                                }
                            });
                    });
                    row.appendChild(button);
                    dropup.appendChild(row);
                }
            })
            .catch((error) => {
                if (!current()) return;
                if (bridgeTab) offerNativePicker();
                else showRpcError(error);
            });
    }

    _renderPiRpcPresets() {
        if (!this.presetsContainer) return;
        const activeTab = this.getActiveTab();
        this.presetsContainer.replaceChildren();
        if (activeTab?.coder !== 'pi-rpc') {
            this.presetsContainer.classList.add('hidden');
            return;
        }
        this._setPiRpcActionVisibility(activeTab);
        this.presetsContainer.classList.remove('hidden');
        const state = this._piRpcControlsFor(activeTab);
        const paneId = activeTab.paneId;
        const menuDisabled = !state.ready || state.exited;

        const compactButton = document.createElement('button');
        compactButton.type = 'button';
        compactButton.className = 'preset-btn pi-rpc-compact-btn';
        compactButton.textContent = 'Compact';
        const compactPending = this._piRpcCompactPending?.has(paneId) === true;
        compactButton.disabled =
            menuDisabled ||
            state.busy ||
            state.queueDepth > 0 ||
            compactPending;
        compactButton.addEventListener('click', (event) => {
            event.stopPropagation();
            if (compactButton.disabled) return;
            if (!this._piRpcCompactPending)
                this._piRpcCompactPending = new Set();
            this._piRpcCompactPending.add(paneId);
            this.renderPresets('pi-rpc');
            let compactResult;
            try {
                compactResult = rpcChatCompact(paneId);
            } catch (error) {
                compactResult = Promise.reject(error);
            }
            Promise.resolve(compactResult)
                .catch((error) => {
                    if (this.tabs.has(paneId))
                        this._piRpcError(error, 'Compact');
                })
                .finally(() => {
                    this._piRpcCompactPending.delete(paneId);
                    if (this.getActiveTab()?.paneId === paneId)
                        this.renderPresets('pi-rpc');
                });
        });

        const resetButton = document.createElement('button');
        resetButton.type = 'button';
        resetButton.className = 'preset-btn pi-rpc-reset-btn';
        resetButton.textContent = 'Clear';
        resetButton.title = 'Reset Chat — fresh conversation';
        const resetPending = this._piRpcResetPending?.has(paneId) === true;
        resetButton.disabled =
            menuDisabled || state.busy || state.queueDepth > 0 || resetPending;
        resetButton.addEventListener('click', (event) => {
            event.stopPropagation();
            if (resetButton.disabled) return;
            if (
                state.hasTranscript &&
                !confirm(
                    'Reset Chat starts a fresh conversation and cannot be undone. Continue?',
                )
            )
                return;
            if (!this._piRpcResetPending) this._piRpcResetPending = new Set();
            this._piRpcResetPending.add(paneId);
            this.renderPresets('pi-rpc');
            let resetResult;
            try {
                resetResult = rpcChatReset(paneId);
            } catch (error) {
                resetResult = Promise.reject(error);
            }
            Promise.resolve(resetResult)
                .then((data) => {
                    this._onPiRpcResetResult(paneId, data);
                })
                .catch((error) => this._piRpcError(error, 'Reset Chat'))
                .finally(() => {
                    this._piRpcResetPending.delete(paneId);
                    if (this.getActiveTab()?.paneId === paneId)
                        this.renderPresets('pi-rpc');
                });
        });
        const thinkingVisibilityBtn = document.createElement('button');
        thinkingVisibilityBtn.type = 'button';
        thinkingVisibilityBtn.className = 'preset-btn';
        if (!this._thinkingAllVisible) this._thinkingAllVisible = new Map();
        const allVisible = this._thinkingAllVisible.get(paneId) === true;
        thinkingVisibilityBtn.textContent = allVisible
            ? 'Hide thinking'
            : 'Show thinking';
        thinkingVisibilityBtn.title = 'Toggle all thinking blocks';
        thinkingVisibilityBtn.disabled = menuDisabled;
        thinkingVisibilityBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!this._thinkingAllVisible) this._thinkingAllVisible = new Map();
            const next = !(this._thinkingAllVisible.get(paneId) === true);
            this._thinkingAllVisible.set(paneId, next);
            const container = this.tabs.get(paneId)?.termContainer;
            if (container) {
                container.querySelectorAll('.thinking-block').forEach((el) => {
                    el.classList.toggle('collapsed', !next);
                    const t = el.querySelector('.thinking-toggle');
                    if (t) t.textContent = next ? '▼' : '▶';
                });
            }
            this.renderPresets('pi-rpc');
        });

        const divider = document.createElement('div');
        divider.className = 'presets-divider';

        const quickCmdsButton = document.createElement('button');
        quickCmdsButton.type = 'button';
        quickCmdsButton.className = 'preset-btn model-trigger-btn';
        quickCmdsButton.textContent = 'Cmds ▾';
        quickCmdsButton.disabled = menuDisabled;
        quickCmdsButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this._toggleDropup('quick-commands-dropup', quickCmdsButton, () =>
                this.renderQuickCmdsDropup(),
            );
        });

        const modelButton = document.createElement('button');
        modelButton.type = 'button';
        modelButton.className =
            'preset-btn model-trigger-btn pi-rpc-model-trigger';
        modelButton.textContent = '🤖 Models ▾';
        modelButton.title = state.model || '—';
        modelButton.disabled = menuDisabled;
        modelButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this._toggleDropup('pi-rpc-model-dropup', modelButton, () =>
                this._renderPiRpcModelsDropup(),
            );
        });

        const thinkingButton = document.createElement('button');
        thinkingButton.type = 'button';
        thinkingButton.className =
            'preset-btn model-trigger-btn pi-rpc-thinking-trigger';
        thinkingButton.textContent = 'Thinking ▾';
        thinkingButton.title = state.thinking || '—';
        thinkingButton.disabled =
            menuDisabled || this._piRpcThinkingPending?.paneId === paneId;
        thinkingButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this._toggleDropup('pi-rpc-thinking-dropup', thinkingButton, () =>
                this._renderPiRpcThinkingDropup(),
            );
        });

        this.presetsContainer.append(
            compactButton,
            resetButton,
            thinkingVisibilityBtn,
            divider,
            quickCmdsButton,
            modelButton,
            thinkingButton,
        );
        const qcDropup = document.getElementById('quick-commands-dropup');
        if (qcDropup && !qcDropup.classList.contains('hidden'))
            this.renderQuickCmdsDropup();
        const mDropup = document.getElementById('pi-rpc-model-dropup');
        if (mDropup && !mDropup.classList.contains('hidden'))
            this._renderPiRpcModelsDropup(true);
        const tDropup = document.getElementById('pi-rpc-thinking-dropup');
        if (tDropup && !tDropup.classList.contains('hidden'))
            this._renderPiRpcThinkingDropup();
    }

    switchTab(paneId, { userInitiated = false } = {}) {
        this._closePiRpcDropups();
        if (this.activePaneId === paneId) {
            const activeTab = this.getActiveTab();
            if (activeTab) {
                // Already on this tab - the user just clicked the active tab to
                // refocus. Don't scroll the terminal to bottom (loses their
                // scrollback position), but still run fit + reconnect so the
                // tab gets a chance to revive itself on explicit click.
                // Use scrollToBottom:false so a user mid-scrollback reading
                // old output doesn't get yanked to the bottom line.
                this.activateTabViewport(activeTab, {
                    scrollToBottom: false,
                    autoReconnect: true,
                    force: userInitiated,
                });
            }
            this.renderPiRpcStatusBar();
            return;
        }

        this._resetPiRecall({ flush: true });
        // Deactivate current active tab
        const prevTab = this.getActiveTab();
        if (prevTab) {
            if (prevTab.term) {
                prevTab.isAtBottom =
                    prevTab.term.buffer.active.viewportY >=
                    prevTab.term.buffer.active.baseY;
                prevTab.lastScrollY = prevTab.term.buffer.active.viewportY;
            }
            // Park the draft on the outgoing tab, mirroring the scroll save
            // above. review/kanban tabs hide the input bar and never carry
            // one. Guard inputTextArea: test harnesses build partial managers.
            if (
                this.inputTextArea &&
                prevTab.coder !== 'review' &&
                prevTab.coder !== 'kanban'
            ) {
                prevTab.draft = this.inputTextArea.value;
                prevTab.draftAttachments = this.stagedAttachments;
                this.saveTabDraft(prevTab);
            }
            prevTab.tabEl.classList.remove('active');
            prevTab.termContainer.classList.remove('active');
            // Leaving a Pi tab revokes its pending Thinking operation so a
            // late reply cannot act after the user navigates back.
            if (prevTab.coder === 'pi')
                this._invalidatePiBridgeThinking(prevTab);
        }

        // Set new active tab
        this.activePaneId = paneId;
        const newTab = this.getActiveTab();
        if (!newTab) return;
        this._setPiRpcActionVisibility(newTab);

        newTab.tabEl.classList.add('active');
        newTab.termContainer.classList.add('active');
        if (newTab.isAttention) {
            this._setTabAttention(newTab, false);
            this.updateDocumentTitle();
        }
        this.renderPiRpcStatusBar();
        // Fleet strip follows the active tab: replay the pi-rpc pane's
        // last snapshot, or hide the strip for tabs without a chat pane.
        syncPiSubagentStrip(newTab.paneId);

        // Show/hide staged input & direct mode based on tab settings
        if (newTab.coder === 'review' || newTab.coder === 'kanban') {
            this.inputBarContainer.classList.add('hidden');
        } else {
            this.inputBarContainer.classList.remove('hidden');
            this.updateDirectModeUI(newTab);
            // Restore the incoming tab's parked draft. Reset the prompt-
            // history cycle too: _historyPreCycleValue belongs to the
            // outgoing tab's draft and Alt+Down would paste it here.
            if (this.inputTextArea) {
                this.inputTextArea.value = newTab.draft || '';
                this.lastInputValue = this.inputTextArea.value;
                this.stagedAttachments = newTab.draftAttachments || [];
                this._renderAttachmentStrip();
                this.adjustInputHeight();
                this._historyCursor = -1;
                this._historyPreCycleValue = undefined;
                if (newTab.coder === 'pi-rpc') {
                    newTab.chatHistoryCursor = -1;
                    newTab.chatHistoryPreCycleValue = undefined;
                }
            }
        }

        // Scroll tabs bar to active tab
        newTab.tabEl.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'nearest',
        });
        this.saveTabsState();
        this.updateTabOverflow?.();
        this._refreshOverflowDropdown?.();

        // Close-triggered selections use the same project synchronization as
        // any other tab selection so the sidebar matches the active tab.
        // Preserve scroll position if user had scrolled up in newTab; only snap to
        // bottom if newTab is following bottom or already at bottom.
        const shouldScrollToBottom = newTab.term
            ? newTab.userFollowBottom !== false &&
              (newTab.term.buffer?.active?.viewportY ?? 0) >=
                  (newTab.term.buffer?.active?.baseY ?? 0)
            : true;

        if (this._syncProjectForTab(newTab)) {
            this.activateTabViewport(newTab, {
                scrollToBottom: shouldScrollToBottom,
                autoReconnect: true,
                force: userInitiated,
            });
            return;
        }

        this.activateTabViewport(newTab, {
            scrollToBottom: shouldScrollToBottom,
            autoReconnect: true,
            force: userInitiated,
        });
        this.updateDocumentTitle();
    }

    // Update sidebar state for an explicit tab selection. Returns true for
    // independent views whose viewport activation is handled by switchTab.
    _syncProjectForTab(newTab) {
        // pi-rpc is a chat tab opened via the eye icon — it must NOT hijack
        // the left Pi tab's activeCoder or trigger a worktree reload.
        const prevCoder = this.app.sessionsManager.activeCoder;
        if (newTab.coder !== 'pi-rpc') {
            this.app.sessionsManager.switchCoder(newTab.coder, true);
        }

        // Kanban and review are independent views. They do not track the
        // user's terminal project context, so never apply their snapshot.
        if (
            newTab.coder === 'kanban' ||
            newTab.coder === 'review' ||
            newTab.coder === 'pi-rpc'
        ) {
            this.app.sessionsManager.highlightActiveSession(newTab.sessionId);
            return true;
        }

        const selectedWorkspace =
            newTab.workspace || this.app.sessionsManager.activeWorkspace;
        const selectedCoder = newTab.coder;
        const selectedCwd = newTab.cwd;
        const isCurrentProjectContext = () => {
            const sessionsManager = this.app.sessionsManager;
            return (
                sessionsManager.activeCoder === selectedCoder &&
                (!selectedWorkspace ||
                    (sessionsManager.activeWorkspace &&
                        normalizePath(sessionsManager.activeWorkspace) ===
                            normalizePath(selectedWorkspace))) &&
                (!selectedCwd ||
                    (sessionsManager.activeCWD &&
                        normalizePath(sessionsManager.activeCWD) ===
                            normalizePath(selectedCwd)))
            );
        };

        // Sync project / workspace context from the tab using normalized paths.
        const workspaceChanged =
            newTab.workspace &&
            normalizePath(this.app.sessionsManager.activeWorkspace) !==
                normalizePath(newTab.workspace);
        const coderChanged = prevCoder !== newTab.coder;
        const cwdChanged =
            newTab.cwd &&
            normalizePath(this.app.sessionsManager.activeCWD) !==
                normalizePath(newTab.cwd);

        if (newTab._detachedCache) {
            if (workspaceChanged) {
                this.app.sessionsManager.workspaceSelect.value = newTab.workspace;
                this.app.sessionsManager.activeWorkspace = newTab.workspace;
                this.app.sessionsManager.activeCWD = newTab.cwd;
                this.app.sessionsManager.updateWorkspaceSelectWidth();
            } else if (coderChanged) {
                this.app.sessionsManager.activeCWD = newTab.cwd;
            }
            return false;
        }

        if (workspaceChanged) {
            this.app.sessionsManager.workspaceSelect.value = newTab.workspace;
            this.app.sessionsManager.activeWorkspace = newTab.workspace;
            this.app.sessionsManager.activeCWD = newTab.cwd;
            this.app.sessionsManager.updateWorkspaceSelectWidth();

            this.app.sessionsManager.loadWorktrees(newTab.cwd).then(() => {
                if (!isCurrentProjectContext()) return;
                const activeTab = this.getActiveTab();
                if (activeTab) {
                    this.app.sessionsManager.highlightActiveSession(
                        activeTab.sessionId,
                    );
                }
                this.app.diffController.refreshDiff();
                if (this.app.markdownManager) {
                    this.app.markdownManager.refreshFiles({ force: false });
                }
            });
        } else if (coderChanged) {
            // Workspace is the same, but coder changed. Rebuild worktrees for
            // the new coder.
            this.app.sessionsManager.activeCWD = newTab.cwd;
            this.app.sessionsManager.loadWorktrees(newTab.cwd).then(() => {
                if (!isCurrentProjectContext()) return;
                const activeTab = this.getActiveTab();
                if (activeTab) {
                    this.app.sessionsManager.highlightActiveSession(
                        activeTab.sessionId,
                    );
                }
                this.app.diffController.refreshDiff();
                if (this.app.markdownManager) {
                    this.app.markdownManager.refreshFiles({ force: false });
                }
            });
        } else if (cwdChanged) {
            // Workspace and coder are the same, only CWD changed.
            this.app.sessionsManager.activeCWD = newTab.cwd;
            this.app.sessionsManager.highlightActiveWorktree(newTab.cwd);
            this.app.sessionsManager.highlightActiveSession(newTab.sessionId);
            this.app.diffController.refreshDiff();
            if (this.app.markdownManager) {
                this.app.markdownManager.refreshFiles({ force: false });
            }
        } else {
            // Workspace, coder, and CWD are all the same; only the session
            // may have changed.
            this.app.sessionsManager.highlightActiveSession(newTab.sessionId);
            if (this.app.markdownManager) {
                this.app.markdownManager.refreshFiles({
                    force: false,
                    silent: true,
                });
            }
        }
        return false;
    }

    togglePinTab(paneId) {
        const tab = this.tabs.get(paneId);
        if (!tab) return;

        tab.pinned = !tab.pinned;
        if (tab.pinned) {
            tab.tabEl.classList.add('pinned');
        } else {
            tab.tabEl.classList.remove('pinned');
        }

        // Sync with backend API.
        this.syncBackendPin(paneId, tab.pinned);

        this.saveTabsState();
    }

    syncBackendPin(paneId, pinned) {
        fetch(`/api/terminals/${paneId}/pin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned: pinned }),
        }).catch((err) =>
            console.error('[term] Failed to sync pin on backend:', err),
        );
    }

    syncBackendMark(paneId, marked) {
        fetch(`/api/terminals/${paneId}/mark`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ marked: marked }),
        }).catch((err) =>
            console.error('[term] Failed to sync mark on backend:', err),
        );
    }

    _setTabTitle(tabInfo, title) {
        if (!tabInfo || typeof title !== 'string') return false;
        const changed = tabInfo.title !== title;
        tabInfo.title = title;
        const titleEl = tabInfo.tabEl?.querySelector('.tab-title');
        // A native update changes stored state while the editor owns the
        // label node; never replace or overwrite that draft.
        if (titleEl && titleEl.tagName !== 'INPUT') {
            titleEl.textContent = title;
            titleEl.classList.toggle('marked', !!tabInfo.marked);
        }
        this.updateTabOverflow?.();
        this._refreshOverflowDropdown?.();
        if (
            this._hieroPreview?.classList.contains('visible') &&
            this._hieroPreviewSourceEl === tabInfo.tabEl
        ) {
            this._showHieroPreview(tabInfo.tabEl);
        }
        return changed;
    }

    openTabRenamer(paneId, titleEl) {
        const tab = this.tabs.get(paneId);
        if (!tab) return;
        const openingTitle = tab.title || '';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input tab-title';
        input.value = openingTitle;
        titleEl.replaceWith(input);
        input.focus({ preventScroll: true });
        input.select();

        const restoreLatestTitle = () => {
            const span = document.createElement('span');
            span.className = `tab-title ${tab.marked ? 'marked' : ''}`;
            input.replaceWith(span);
            this._setTabTitle(tab, tab.title || '');
        };
        let done = false;
        const commit = () => {
            if (done) return;
            done = true;
            const next = input.value.trim();
            const latestTitle = tab.title || '';
            if (next && next !== openingTitle && next !== latestTitle) {
                if (tab.isReview || tab.isKanban) {
                    // Review and Kanban tabs own their own titles; no
                    // backend sync.
                    this._setTabTitle(tab, next);
                } else if (tab.isChatRpc) {
                    // Pi RPC keeps the current label until Pi's native
                    // session_info_changed event reaches the backend.
                    rpcChatSetName(paneId, next).catch((error) =>
                        console.error(
                            '[term] Failed to rename Pi RPC session:',
                            error,
                        ),
                    );
                    this.app?.sessionsManager?.loadSessions?.();
                } else if (tab.coder === 'pi') {
                    // The backend sends one native /name command. Keep the
                    // current label until file-backed native state confirms it.
                    this.syncBackendTitle(paneId, next).catch(() => {});
                    setTimeout(() => {
                        this.app?.sessionsManager?.loadSessions?.();
                    }, 600);
                } else {
                    this._setTabTitle(tab, next);
                    this.syncBackendTitle(paneId, next).catch(() => {});
                }
            }
            restoreLatestTitle();
        };
        const cancel = () => {
            if (done) return;
            done = true;
            restoreLatestTitle();
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        });
        input.addEventListener('blur', commit);
    }

    syncBackendTitle(paneId, title) {
        return fetch(`/api/terminals/${paneId}/title`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title }),
        })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} renaming terminal`);
                }
                return response;
            })
            .catch((err) => {
                console.error('[term] Failed to sync title on backend:', err);
                throw err;
            });
    }

    // Soft-close: when the user clicks × on a tab, the tab leaves the
    // visible strip for SOFT_CLOSE_GRACE_MS and appears in the tab-list
    // dropdown with an Undo action. The PTY stays alive until the grace
    // expires, so an accidental close remains recoverable without making
    // the real tab bar noisy.
    //
    // Closing the active tab selects the nearest surviving tab, but that
    // programmatic selection preserves the current project/worktree. Only
    // an explicit user tab selection is allowed to change the sidebar.
    //
    // MAX_SOFT_CLOSED_TABS bounds the grace memory footprint. Past that,
    // the oldest closing tab is finalized immediately.
    static SOFT_CLOSE_GRACE_MS = 3000;
    static MAX_SOFT_CLOSED_TABS = 3;

    closeTab(paneId) {
        const tab = this.tabs.get(paneId);
        if (!tab) return;

        // If already soft-closing, the user clicked × again - treat it as
        // "I really mean it" and finalize immediately. They can still
        // click Undo in the toast within the grace window if it changed
        // their mind, but normally this just shortens the grace.
        if (tab.softClosing) {
            this.finalizeCloseTab(paneId);
            return;
        }

        this.softCloseTab(paneId);
    }

    // Mark tab as soft-closing: strip entry fades, × swaps to ↻, a tiny
    // countdown pill appears on the strip so the user can see how long
    // they have to undo. The PTY is NOT killed yet — if the user clicks
    // ↻, or the "Undo" button in the toast, the tab is restored.
    //
    // A closing tab is hidden from the strip while it remains recoverable
    // during the undo grace. An active close selects a visible survivor;
    // undo restores the tab through ordinary selection. After the 3s grace
    // (or × twice), the closing tab is finalized.
    softCloseTab(paneId) {
        const tab = this.tabs.get(paneId);
        if (!tab || tab.softClosing) return;

        const wasActive = this.activePaneId === paneId;
        tab.softClosing = true;
        tab.softCloseStartedAt = Date.now();
        tab.tabEl.classList.add('soft-closed');

        // Cap: if too many closing tabs exist, finalize the oldest. This
        // keeps the dropdown bounded and the grace memory footprint small.
        const softTabs = Array.from(this.tabs.values()).filter(
            (t) => t.softClosing,
        );
        if (softTabs.length > TabManager.MAX_SOFT_CLOSED_TABS) {
            softTabs.sort(
                (a, b) =>
                    (a.softCloseStartedAt || 0) - (b.softCloseStartedAt || 0),
            );
            this.finalizeCloseTab(softTabs[0].paneId);
            if (!this.tabs.has(paneId)) return;
        }

        this._startSoftCloseCountdown(tab);

        // Closing the active tab selects and synchronizes a visible survivor.
        if (wasActive) this._selectTabAfterClose(paneId);

        // Undo toast for all soft-closes. The dropdown is the durable
        // recovery affordance; the toast remains a quick shortcut.
        if (this.app?.showToast) {
            const toastEl = this.app.showToast(
                `Closed "${tab.title || tab.coder || 'tab'}"`,
                {
                    type: 'info',
                    title: 'Tab closed',
                    duration: TabManager.SOFT_CLOSE_GRACE_MS,
                    action: {
                        text: 'Undo',
                        callback: () => this.undoCloseTab(paneId),
                    },
                },
            );
            tab.softCloseToast = toastEl;
        }

        tab.softCloseTimer = setTimeout(() => {
            this.finalizeCloseTab(paneId);
        }, TabManager.SOFT_CLOSE_GRACE_MS);
        this.updateTabOverflow?.();
        this._refreshOverflowDropdown?.();
        // An open hostname list stays open across strip-× soft-close:
        // closing rows must lose their cues and unread priority at once.
        this._refreshHostnameTabsDropdown?.();
    }

    _selectTabAfterClose(paneId) {
        if (this.activePaneId !== paneId) return;
        const ordered = Array.from(this.tabs.values());
        const currentIndex = ordered.findIndex((tab) => tab.paneId === paneId);
        let nextTab = null;
        for (let offset = 1; offset < ordered.length; offset += 1) {
            const candidate = ordered[(currentIndex + offset) % ordered.length];
            if (candidate && !candidate.softClosing) {
                nextTab = candidate;
                break;
            }
        }
        if (nextTab) {
            this.hideEmptyState?.();
            this.switchTab(nextTab.paneId);
            return;
        }

        // No visible survivor remains. Leave the closing tabs recoverable in
        // the dropdown, but show the normal empty state during the grace.
        const tab = this.tabs.get(paneId);
        // Soft-close keeps socket and bridge state alive for Undo, so revoke
        // the pending Thinking operation or it still owns the restored context.
        if (tab?.coder === 'pi') this._invalidatePiBridgeThinking(tab);
        tab?.tabEl?.classList.remove('active');
        tab?.termContainer?.classList.remove('active');
        this.activePaneId = null;
        this._closePiRpcDropups?.(true);
        this._setPiRpcActionVisibility?.(null);
        this.inputBarContainer?.classList.add('hidden');
        this.presetsContainer?.replaceChildren();
        this.presetsContainer?.classList.add('hidden');
        syncPiSubagentStrip('');
        this.renderPiRpcStatusBar?.();
        this.showEmptyState?.();
        this.updateDocumentTitle?.();
        this.saveTabsState?.();
    }

    _softCloseRemainingSeconds(tab) {
        const startedAt = tab.softCloseStartedAt || Date.now();
        return Math.max(
            0,
            Math.ceil(
                (TabManager.SOFT_CLOSE_GRACE_MS - (Date.now() - startedAt)) /
                    1000,
            ),
        );
    }

    _updateClosingTabCountdown(tab) {
        const dropdown = document.getElementById('tab-overflow-dropdown');
        if (!dropdown || dropdown.classList.contains('hidden')) return;
        for (const row of dropdown.querySelectorAll(
            '.tab-overflow-closing-row',
        )) {
            if (row.dataset.paneId !== tab.paneId) continue;
            const countdown = row.querySelector(
                '.tab-overflow-closing-countdown',
            );
            if (countdown) {
                countdown.textContent = `Closing in ${this._softCloseRemainingSeconds(tab)}s`;
            }
            break;
        }
    }

    // Keep the closing-tab row current while its dropdown is open. When the
    // dropdown is closed, its next render computes the remaining time fresh.
    _startSoftCloseCountdown(tab) {
        const tick = () => {
            this._updateClosingTabCountdown(tab);
            if (this._softCloseRemainingSeconds(tab) <= 0) {
                this._stopSoftCloseCountdown(tab);
            }
        };
        tick();
        tab.softCloseCountdownTimer = setInterval(tick, 250);
    }

    _stopSoftCloseCountdown(tab) {
        if (tab.softCloseCountdownTimer) {
            clearInterval(tab.softCloseCountdownTimer);
            tab.softCloseCountdownTimer = null;
        }
        this.updateTabOverflow?.();
    }

    // Reverse a soft-close: cancel the timer, restore the strip entry,
    // and explicitly select the tab. Explicit Undo is a normal user
    // selection, so it is allowed to restore that tab's project context.
    undoCloseTab(paneId) {
        const tab = this.tabs.get(paneId);
        if (!tab?.softClosing) return;

        if (tab.softCloseTimer) {
            clearTimeout(tab.softCloseTimer);
            tab.softCloseTimer = null;
        }
        if (tab.softCloseToast) {
            tab.softCloseToast.classList.remove('show');
            setTimeout(() => tab.softCloseToast?.remove(), 200);
            tab.softCloseToast = null;
        }
        this._stopSoftCloseCountdown(tab);

        tab.softClosing = false;
        tab.softCloseStartedAt = null;
        tab.tabEl.classList.remove('soft-closed');
        if (this.activePaneId === null) this.hideEmptyState?.();

        this.switchTab(paneId, { userInitiated: true });
        this.updateTabOverflow?.();
        this._refreshOverflowDropdown?.();
    }

    disposeTabClient(paneId, { preserveStorage = false } = {}) {
        const tab = this.tabs.get(paneId);
        if (!tab) return;
        tab.finalizing = true;

        this._cancelHistoryRequest?.(tab);
        // The pending native Compact waiter is pane-keyed, so a closed
        // pane must drop it here or a later tab on the same pane id
        // inherits "Compacting…" from this one.
        this._invalidatePiBridgeCompact?.(tab);
        tab._panelObserver?.disconnect();
        if (tab._panelFitRAF != null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(tab._panelFitRAF);
        }
        tab._panelFitRAF = null;

        if (tab._openFallbackTimer) {
            clearTimeout(tab._openFallbackTimer);
            tab._openFallbackTimer = null;
        }
        if (tab._ckptTimer) {
            clearTimeout(tab._ckptTimer);
            tab._ckptTimer = null;
        }
        if (tab._writeRetryTimer) {
            clearTimeout(tab._writeRetryTimer);
            tab._writeRetryTimer = null;
        }
        if (tab.spamInterval) {
            clearInterval(tab.spamInterval);
            tab.spamInterval = null;
        }
        if (tab.stopSpamTimeout) {
            clearTimeout(tab.stopSpamTimeout);
            tab.stopSpamTimeout = null;
        }

        if (tab.softCloseTimer) {
            clearTimeout(tab.softCloseTimer);
            tab.softCloseTimer = null;
        }
        if (tab.softCloseToast) {
            tab.softCloseToast.classList.remove('show');
            setTimeout(() => tab.softCloseToast?.remove(), 200);
            tab.softCloseToast = null;
        }
        this._stopSoftCloseCountdown?.(tab);

        if (tab.coder === 'pi-rpc' && typeof destroyRpcChat === 'function') {
            destroyRpcChat(tab.paneId);
        }

        if (tab.autoReconnectTimer) {
            clearTimeout(tab.autoReconnectTimer);
            tab.autoReconnectTimer = null;
        }
        if (tab.reconnectStableTimer) {
            clearTimeout(tab.reconnectStableTimer);
            tab.reconnectStableTimer = null;
        }
        if (tab.reconnectWatchdogTimer) {
            clearTimeout(tab.reconnectWatchdogTimer);
            tab.reconnectWatchdogTimer = null;
        }

        try {
            if (tab.ws) tab.ws.close();
        } catch (e) {
            console.error('[tab] WS close error:', e);
        }

        try {
            if (tab.term) tab.term.dispose();
        } catch (e) {
            console.error('[tab] Term dispose error:', e);
        }

        try {
            if (tab.tabEl) tab.tabEl.remove();
            if (tab.termContainer) tab.termContainer.remove();
        } catch (e) {
            console.error('[tab] DOM removal error:', e);
        }

        if (this.app?.kanbanManager && tab.isKanban) {
            this.app.kanbanManager.cleanup?.();
        }
        if (this.app?.reviewManager && tab.isReview) {
            this.app.reviewManager.cleanup?.();
        }

        if (tab.coder === 'pi-rpc' && this.activePaneId === paneId) {
            this._piRpcResetPending?.delete(paneId);
            this._closePiRpcDropups?.(true);
        }

        const wasPiRpc = tab.coder === 'pi-rpc';
        // The pane is leaving the map, so bridge Thinking ownership goes with
        // it; a stuck pending would block the Thinking controls elsewhere.
        this._invalidatePiBridgeThinking(tab);
        this._clearPiRpcModelPending(tab.paneId);
        // A detach keeps the pane and its catalog for the reconnect; only a
        // real close drops the entry.
        if (!preserveStorage) this._forgetPiRpcModelCache(tab.coder, tab.paneId);
        this.tabs.delete(paneId);

        if (!preserveStorage) {
            try {
                localStorage.removeItem(serverKey(`phi_tab_draft_${paneId}`));
            } catch {}
            this.updateDocumentTitle?.();
            this.updateDisconnectBanner?.();
            this.saveTabsState?.();
            if (wasPiRpc) this.savePiRpcTabs?.();

            this.updateTabOverflow?.();
            this._refreshOverflowDropdown?.();
            if (document.body?.classList?.contains('show-tab-shortcuts')) {
                this.updateTabShortcutHints?.(true);
            }

            if (this.tabs.size === 0) {
                this.activePaneId = null;
                this._setPiRpcActionVisibility?.(null);
                this._closePiRpcDropups?.(true);
                this.inputBarContainer?.classList?.add('hidden');
                this.presetsContainer?.replaceChildren?.();
                this.presetsContainer?.classList?.add('hidden');
                this.renderPiRpcStatusBar?.();
                this.showEmptyState?.();
                if (this.app?.markdownManager) {
                    this.app.markdownManager.refreshFiles?.({ force: true });
                }
            } else if (this.activePaneId === paneId) {
                const survivor = Array.from(this.tabs.values()).find(
                    (candidate) => !candidate.softClosing,
                );
                if (survivor) {
                    this.switchTab?.(survivor.paneId);
                }
            }
        }
    }

    // Actually kill the PTY, close WS, dispose term, drop from Map.
    // Called by the grace timer, by the cap-forced finalize, or by
    // closeTab's "user clicked × twice" path. Idempotent: a single
    // setTimeout + cap-forced-finalize-from-the-newest-close + a
    // double-× click can all race for the same pane; this is
    // guarded so DELETE fires exactly once per tab.
    finalizeCloseTab(paneId, { backendId } = {}) {
        const tab = this.tabs.get(paneId);
        if (!tab) return;
        // Re-entry guard: if finalization is already in progress (from
        // another entry point), don't fire a second DELETE or run the
        // cleanup twice. We use this flag instead of relying on
        // tabs.delete() as the gate, because the delete happens *after*
        // the fetch — the second caller would otherwise race the first.
        if (tab.finalizing) return;
        tab.finalizing = true;

        // Kill the server-side PTY process. We previously swallowed
        // failures with .catch(() => {}) — that hid the actual user
        // bug ("process never gets closed"). Now we surface non-2xx and
        // network errors as a toast so the user knows the PTY may still
        // be alive on the server (e.g. a race with another tab close,
        // network blip, or 5xx). The 30-min detach grace timer is the
        // server-side backstop either way.
        if (tab.coder !== 'pi-rpc' && !tab.isKanban && !tab.isReview) {
            const targetBackend = backendId || getEmbeddedProfileId();
            const init = targetBackend
                ? { method: 'DELETE', headers: { 'X-Phi-Backend': targetBackend } }
                : { method: 'DELETE' };
            fetch(`/api/terminals/${paneId}`, init)
                .then((res) => {
                    if (!res.ok && res.status !== 404) {
                        // 404 is fine — it just means another caller already
                        // killed the instance. Anything else (5xx, network,
                        // CORS) is worth telling the user about.
                        throw new Error(`DELETE returned ${res.status}`);
                    }
                })
                .catch((err) => {
                    console.error('[tab] failed to kill PTY for', paneId, err);
                    if (this.app?.showToast) {
                        this.app.showToast(
                            `Could not close "${tab.title || paneId}" on the server — the underlying process may still be running. Try "Restart phi" if it persists.`,
                            { type: 'error', duration: 8000 },
                        );
                    }
                });
        }

        this.disposeTabClient(paneId, { preserveStorage: false });
    }

    flushPendingCloses(backendId) {
        for (const tab of Array.from(this.tabs.values())) {
            if (tab.softClosing) {
                this.finalizeCloseTab(tab.paneId, { backendId });
            }
        }
    }

    detachAll({ flushBackendId } = {}) {
        this.saveActiveDraft?.();
        this.flushPendingCloses(flushBackendId);
        for (const paneId of Array.from(this.tabs.keys())) {
            this.disposeTabClient(paneId, { preserveStorage: true });
        }
        this.activePaneId = null;
        this.inputBarContainer?.classList?.add('hidden');
        this.presetsContainer?.replaceChildren?.();
        this.presetsContainer?.classList?.add('hidden');
        this._closePiRpcDropups?.(true);
        syncPiSubagentStrip?.('');
        this.renderPiRpcStatusBar?.();
        this.updateDocumentTitle?.();
        this.updateDisconnectBanner?.();
        this.updateTabOverflow?.();
        this._refreshOverflowDropdown?.();
        this.showEmptyState?.();
    }

    // Closing-tab selection is handled immediately by _selectTabAfterClose;
    // the grace timer only finalizes the already-hidden tab.

    showEmptyState() {
        const el = document.getElementById('empty-state');
        if (el) {
            el.classList.remove('hidden');
            const hostDisplay = document.getElementById('empty-state-hostname');
            if (hostDisplay) {
                hostDisplay.innerText = this.app.hostname || 'Localhost';
            }
        }
    }

    hideEmptyState() {
        const el = document.getElementById('empty-state');
        if (el) el.classList.add('hidden');
    }

    // ---- Tab list selector + workspace grouping --------------------
    //
    // The tab-list button stays available for all open tabs and the
    // separate Closing tabs section; its tooltip reports clipping.

    updateTabOverflow() {
        const strip = document.getElementById('tabs-container');
        const btn = document.getElementById('tab-overflow-btn');
        if (!strip || !btn) return;

        const closingCount = Array.from(this.tabs?.values?.() || []).filter(
            (tab) => tab.softClosing,
        ).length;
        // Count live tabs whose right edge is clipped. Soft-closed tabs
        // remain in the DOM to preserve their order, but are not strip tabs.
        const stripRect = strip.getBoundingClientRect();
        let hiddenCount = 0;
        for (const tabEl of strip.querySelectorAll('.tab')) {
            if (tabEl.classList.contains('soft-closed')) continue;
            const tabRect = tabEl.getBoundingClientRect();
            if (tabRect.left >= stripRect.right - 1) hiddenCount += 1;
            else if (
                tabRect.right > stripRect.right + 1 &&
                tabRect.left > stripRect.left &&
                tabRect.right - stripRect.right > tabRect.width / 2
            ) {
                hiddenCount += 1;
            }
        }

        const details = [];
        if (hiddenCount > 0)
            details.push(
                `${hiddenCount} more tab${hiddenCount === 1 ? '' : 's'}`,
            );
        if (closingCount > 0)
            details.push(
                `${closingCount} closing tab${closingCount === 1 ? '' : 's'}`,
            );
        const label = details.length
            ? `Show tab list (${details.join(', ')})`
            : 'Show tab list';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.setAttribute(
            'aria-expanded',
            btn.getAttribute('aria-expanded') === 'true' ? 'true' : 'false',
        );
    }

    // ----- Hover preview card -------------------------------------------------
    //
    // A single shared element (#tab-hiero-preview, appended to <body>) shows
    // the hieroglyph large with the worktree label and full path when the
    // user mouses over a tab. Lets users identify which worktree a tab
    // belongs to without reading the path - especially useful after
    // we moved the pool from 12 generic glyphs to 96 distinct Egyptian
    // hieroglyphs, where each glyph is much more memorable.
    _initHieroPreview() {
        if (this._hieroPreview) return;
        const el = document.createElement('div');
        el.className = 'tab-hiero-preview';
        el.id = 'tab-hiero-preview';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = `
            <div class="tab-hiero-preview-glyph"></div>
            <div class="tab-hiero-preview-title"></div>
            <div class="tab-hiero-preview-label"></div>
            <div class="tab-hiero-preview-path"></div>
            <div class="tab-hiero-preview-count"></div>
            <div class="tab-hiero-preview-status"></div>
        `;
        document.body.appendChild(el);
        this._hieroPreview = el;
        this._hieroPreviewSourceEl = null;
        this._hieroPreviewGlyph = el.querySelector('.tab-hiero-preview-glyph');
        this._hieroPreviewTitle = el.querySelector('.tab-hiero-preview-title');
        this._hieroPreviewLabel = el.querySelector('.tab-hiero-preview-label');
        this._hieroPreviewPath = el.querySelector('.tab-hiero-preview-path');
        this._hieroPreviewCount = el.querySelector('.tab-hiero-preview-count');
        this._hieroPreviewStatus = el.querySelector(
            '.tab-hiero-preview-status',
        );

        // Event delegation on the tabs container - one listener, works for
        // every tab and any tab created later (event bubbles up).
        if (this.tabsContainer) {
            // relatedTarget guard: mouseover/mouseout fire on every
            // child-boundary crossing inside a tab; only react when the
            // pointer actually enters/leaves the tab, so the preview
            // (and its shimmer) doesn't replay on intra-tab movement.
            this.tabsContainer.addEventListener('mouseover', (e) => {
                const tabEl = e.target.closest('.tab');
                if (tabEl && !tabEl.contains(e.relatedTarget))
                    this._showHieroPreview(tabEl);
            });
            this.tabsContainer.addEventListener('mouseout', (e) => {
                const tabEl = e.target.closest('.tab');
                if (tabEl && !tabEl.contains(e.relatedTarget))
                    this._hideHieroPreview();
            });
        }
        // Sidebar worktree headers also drive the preview: hovering a
        // worktree section in the left panel shows a medium-sized glyph
        // so users can verify the right worktree before clicking.
        const sessionList = document.getElementById('session-list');
        if (sessionList) {
            sessionList.addEventListener('mouseover', (e) => {
                const headerEl = e.target.closest('.worktree-header');
                if (headerEl && !headerEl.contains(e.relatedTarget))
                    this._showWorktreeHieroPreview(headerEl);
            });
            sessionList.addEventListener('mouseout', (e) => {
                const headerEl = e.target.closest('.worktree-header');
                if (headerEl && !headerEl.contains(e.relatedTarget))
                    this._hideHieroPreview();
            });
        }
        // Hide on scroll/resize so the preview never lags behind a moved tab.
        // Cheap idempotent hide; cheap idempotent show on next mouseover.
        window.addEventListener('scroll', () => this._hideHieroPreview(), true);
        window.addEventListener('resize', () => this._hideHieroPreview());
    }

    // Show the preview for a tab. Anchor: below the tab (default large size).
    _showHieroPreview(tabEl) {
        const p = this._hieroPreview;
        if (!p) return;
        const paneId = tabEl.dataset.paneId;
        const tab = this.tabs.get(paneId);
        // Even if we don't have a tab record yet (mid-createTab), we can
        // still show what we know from the DOM data attributes.
        const glyph = tabEl.dataset.worktreeGlyph || '◆';
        const label = (tab && this.getProjectWorktreeLabel(tab.cwd)) || '—';
        const path = tab?.cwd || tabEl.dataset.cwd || '';

        // Title read at hover-time, never stashed, so renames and truncated
        // tab strips always resolve to the current full title. Mid-createTab
        // the Map entry doesn't exist yet - the .tab-title span does.
        const titleSpan = tabEl.querySelector('.tab-title');
        const titleText =
            tab?.title || (titleSpan ? titleSpan.textContent : '');

        // Live status line - coder-agnostic, from the client-side busy/idle
        // tracking every PTY tab gets (isBusy set on output frames, cleared
        // by the idle sweep). Review/kanban tabs have neither field, so the
        // row stays empty and :empty CSS hides it.
        let statusText = '';
        let busy = false;
        if (tab?.isBusy) {
            busy = true;
            statusText = `● busy ${formatDurationMin(Date.now() - (tab.busyStartTime || Date.now()))}`;
        } else if (tab && typeof tab.lastOutputAt === 'number') {
            statusText = `idle · last output ${formatDurationMin(Date.now() - tab.lastOutputAt)} ago`;
        }

        // Count tabs sharing this hieroglyph - lets users see "you have
        // 3 tabs in this worktree" at a glance from the preview.
        let count = 0;
        for (const t of this.tabs.values()) {
            if (t.tabEl && t.tabEl.dataset.worktreeGlyph === glyph) count++;
        }

        this._populateHieroPreview({
            glyph,
            titleText,
            label,
            path,
            sourceEl: tabEl,
            anchor: 'below',
            size: 'large',
            countText:
                count > 1
                    ? `${count} tabs in this worktree`
                    : count === 1
                      ? '1 tab in this worktree'
                      : '',
            statusText,
            busy,
        });
    }

    // Show the preview for a sidebar worktree header. Anchor: right of the
    // header (medium size so it doesn't compete with the tab preview for
    // visual weight).
    _showWorktreeHieroPreview(headerEl) {
        const p = this._hieroPreview;
        if (!p) return;
        const section = headerEl.closest('.worktree-section');
        const path = section ? section.getAttribute('data-worktree-path') : '';
        const glyphEl = headerEl.querySelector('.worktree-section-glyph');
        const glyph = glyphEl ? glyphEl.textContent : '◆';
        const nameEl = headerEl.querySelector('.worktree-name');
        const label = nameEl
            ? nameEl.textContent
            : path
              ? path.split(/[/\\]/).pop()
              : '—';

        // How many tabs would land in this worktree if opened here? Lets
        // the user gauge whether the worktree already has a session
        // before clicking. Cheap: just count open tabs whose cwd matches.
        let count = 0;
        if (path) {
            for (const t of this.tabs.values()) {
                if (t.cwd === path) count++;
            }
        }
        this._populateHieroPreview({
            glyph,
            label,
            path,
            sourceEl: headerEl,
            anchor: 'right',
            size: 'medium',
            countText:
                count > 0
                    ? `${count} tab${count === 1 ? '' : 's'} open in this worktree`
                    : 'no tabs open in this worktree',
        });
    }

    // Common populate + show path. Sets the card text + position based
    // on anchor (below|right) and size (large|medium). titleText/statusText
    // are tab-hover-only; worktree headers leave them empty and the rows
    // collapse via :empty CSS.
    _populateHieroPreview({
        glyph,
        titleText,
        label,
        path,
        sourceEl,
        anchor,
        size,
        countText,
        statusText,
        busy,
    }) {
        const p = this._hieroPreview;
        if (!p) return;
        if (isCoarseViewport()) {
            this._hideHieroPreview();
            return;
        }

        // Toggle the size modifier. Only one size at a time so the
        // transition between sources is clean (e.g., user hovers a
        // tab then a worktree header).
        p.classList.toggle('tab-hiero-preview-medium', size === 'medium');
        p.classList.toggle('is-busy', !!busy);

        this._hieroPreviewSourceEl = sourceEl;
        this._hieroPreviewGlyph.textContent = glyph;
        this._hieroPreviewTitle.textContent = titleText || '';
        this._hieroPreviewLabel.textContent = label || '—';
        this._hieroPreviewPath.textContent = path || '';
        this._hieroPreviewCount.textContent = countText || '';
        this._hieroPreviewStatus.textContent = statusText || '';

        // Position. Fixed positioning uses viewport coords, so we don't
        // need to account for scroll. Both anchors clamp so the card
        // never leaves the viewport.
        const rect = sourceEl.getBoundingClientRect();
        if (anchor === 'right') {
            const left = rect.right + 8;
            const maxLeft = window.innerWidth - 260;
            p.style.left = `${Math.min(maxLeft, left)}px`;
            p.style.top = `${Math.max(8, rect.top)}px`;
            // Worktree side: card is medium so its width is mostly
            // content-driven; CSS caps at 260px.
            p.style.minWidth = '';
        } else {
            // below
            p.style.left = `${Math.max(8, Math.min(window.innerWidth - 200, rect.left))}px`;
            p.style.top = `${rect.bottom + 8}px`;
            // Tabs vary in width; widen the card a bit so the long
            // paths don't wrap awkwardly. CSS caps at 320px.
            p.style.minWidth = `${Math.max(180, rect.width)}px`;
        }

        // Re-trigger the shimmer keyframe by clearing and re-setting
        // animation - forces a reflow so the animation restarts each
        // hover instead of only playing on first show.
        this._hieroPreviewGlyph.style.animation = 'none';
        void this._hieroPreviewGlyph.offsetWidth;
        this._hieroPreviewGlyph.style.animation = '';

        p.classList.add('visible');
    }

    _hideHieroPreview() {
        if (this._hieroPreview) {
            this._hieroPreview.classList.remove('visible');
        }
        this._hieroPreviewSourceEl = null;
    }

    _refreshOverflowDropdown() {
        if (!this._overflowDropdownHidden()) {
            this._buildOverflowDropdown({ preserveState: true });
        }
    }

    // Builds the shared ● completion-attention marker for tab-list rows
    // and tree summaries. The strip indicator in _setTabAttention predates
    // this helper and keeps its own construction.
    _makeAttentionMarker(className, label) {
        const marker = document.createElement('span');
        marker.className = className;
        marker.textContent = '●';
        marker.setAttribute('role', 'img');
        marker.setAttribute('aria-label', label);
        return marker;
    }

    _buildOverflowDropdown({ preserveState = false } = {}) {
        const dropdown = document.getElementById('tab-overflow-dropdown');
        if (!dropdown) return null;

        const collapsedKeys = new Set();
        let savedScrollTop = 0;
        let focusedKey = null;
        let focusedPopup = false;
        if (preserveState) {
            savedScrollTop = dropdown.scrollTop;
            for (const disclosure of dropdown.querySelectorAll(
                'details[data-overflow-group-key]',
            )) {
                if (!disclosure.open) {
                    collapsedKeys.add(disclosure.dataset.overflowGroupKey);
                }
            }
            const active = document.activeElement;
            if (active && dropdown.contains(active)) {
                focusedPopup = active === dropdown;
                focusedKey = active.dataset?.overflowFocusKey || null;
            }
        }

        dropdown.replaceChildren();
        const entries = Array.from(this.tabs?.entries?.() || []);
        const faviconFor = (tab) =>
            tab.faviconUrl ||
            tab.tabEl?.querySelector('.tab-favicon')?.getAttribute('src') ||
            '';
        const appendHeader = (iconText, labelText, itemCount, extra = '') => {
            const header = document.createElement('div');
            header.className = `tab-overflow-dropdown-group${extra}`;
            const icon = document.createElement('span');
            icon.className = 'tab-overflow-dropdown-group-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = iconText;
            const text = document.createElement('span');
            text.textContent = labelText;
            const count = document.createElement('span');
            count.className = 'tab-overflow-count';
            count.textContent = `${itemCount} tab${itemCount === 1 ? '' : 's'}`;
            header.append(icon, text, count);
            dropdown.appendChild(header);
        };
        const appendRow = (
            parent,
            paneId,
            tab,
            { closing = false } = {},
        ) => {
            const row = document.createElement('div');
            row.className = `hostname-dropdown-row${closing ? ' tab-overflow-closing-row' : ''}`;
            row.dataset.paneId = paneId;
            if (!closing && paneId === this.activePaneId)
                row.classList.add('active');
            if (!closing && tab.isAttention)
                row.classList.add('has-attention');

            const selectBtn = document.createElement('button');
            selectBtn.type = 'button';
            selectBtn.className = 'hostname-dropdown-select-btn';
            selectBtn.dataset.overflowFocusKey = JSON.stringify([
                'select',
                paneId,
            ]);
            const faviconImg = document.createElement('img');
            faviconImg.className = 'hostname-dropdown-favicon';
            faviconImg.src = faviconFor(tab);
            faviconImg.alt = tab.coder || '';
            const titleSpan = document.createElement('span');
            titleSpan.className = 'hostname-dropdown-title';
            titleSpan.textContent = tab.title || 'Session';
            selectBtn.append(faviconImg, titleSpan);
            if (!closing && tab.isAttention) {
                selectBtn.appendChild(
                    this._makeAttentionMarker(
                        'hostname-dropdown-attention',
                        'Needs attention',
                    ),
                );
            }

            if (closing) {
                const countdown = document.createElement('span');
                countdown.className =
                    'hostname-dropdown-meta tab-overflow-closing-countdown';
                countdown.textContent = `Closing in ${this._softCloseRemainingSeconds(tab)}s`;
                selectBtn.appendChild(countdown);
                selectBtn.title = 'Undo close';
                selectBtn.addEventListener('click', () => {
                    this.undoCloseTab(paneId);
                    this._closeOverflowDropdown();
                });
            } else {
                selectBtn.addEventListener('click', () => {
                    this.switchTab(paneId, { userInitiated: true });
                    this._closeOverflowDropdown();
                });
            }
            row.appendChild(selectBtn);

            const actionBtn = document.createElement('button');
            actionBtn.type = 'button';
            actionBtn.className = 'hostname-dropdown-close-btn';
            actionBtn.dataset.overflowFocusKey = JSON.stringify([
                'action',
                paneId,
            ]);
            actionBtn.textContent = closing ? '↻' : '×';
            actionBtn.title = closing ? 'Undo close' : 'Close session';
            actionBtn.setAttribute(
                'aria-label',
                closing
                    ? `Undo close ${tab.title || 'session'}`
                    : `Close ${tab.title || 'session'}`,
            );
            actionBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                if (closing) {
                    this.undoCloseTab(paneId);
                    this._closeOverflowDropdown();
                } else {
                    this.closeTab(paneId);
                }
            });
            row.appendChild(actionBtn);
            parent.appendChild(row);
            return row;
        };

        const closingTabs = entries.filter(([, tab]) => tab.softClosing);
        if (closingTabs.length > 0) {
            appendHeader(
                '↻',
                'Closing tabs',
                closingTabs.length,
                ' tab-overflow-closing-group',
            );
            for (const [paneId, tab] of closingTabs) {
                appendRow(dropdown, paneId, tab, { closing: true });
            }
        }

        const liveEntries = entries.filter(([, tab]) => !tab.softClosing);
        const hasUnread = (items) =>
            items.some((entry) => entry[1].isAttention);
        // Unread-bearing groups first; the existing group order stays
        // secondary and each partition keeps its order (stable).
        const workspaceGroups = this._workspaceTabGroups(
            liveEntries,
        ).filter((group) => group.entries.length > 0);
        const orderedWorkspaceGroups = [
            ...workspaceGroups.filter((group) => hasUnread(group.entries)),
            ...workspaceGroups.filter((group) => !hasUnread(group.entries)),
        ];
        for (const workspaceGroup of orderedWorkspaceGroups) {
            const workspace = document.createElement('details');
            workspace.className = 'tab-overflow-workspace';
            workspace.dataset.workspace = workspaceGroup.workspace;
            workspace.dataset.overflowGroupKey = JSON.stringify([
                'workspace',
                workspaceGroup.workspace,
            ]);
            workspace.open = true;
            const workspaceSummary = document.createElement('summary');
            workspaceSummary.dataset.overflowFocusKey =
                workspace.dataset.overflowGroupKey;
            if (workspaceGroup.workspace) {
                workspaceSummary.title = workspaceGroup.workspace;
            }
            const workspaceChevron = document.createElement('span');
            workspaceChevron.className = 'tab-overflow-chevron';
            workspaceChevron.setAttribute('aria-hidden', 'true');
            workspaceChevron.textContent = '›';
            const workspaceLabel = document.createElement('span');
            workspaceLabel.className = 'tab-overflow-summary-label';
            workspaceLabel.textContent = workspaceGroup.label;
            const workspaceCount = document.createElement('span');
            workspaceCount.className = 'tab-overflow-count';
            workspaceCount.textContent = `${workspaceGroup.entries.length} tab${workspaceGroup.entries.length === 1 ? '' : 's'}`;
            workspaceSummary.append(
                workspaceChevron,
                workspaceLabel,
                workspaceCount,
            );
            if (hasUnread(workspaceGroup.entries)) {
                workspace.classList.add('has-attention');
                workspaceSummary.appendChild(
                    this._makeAttentionMarker(
                        'tab-overflow-attention',
                        'Contains tabs needing attention',
                    ),
                );
            }
            workspace.appendChild(workspaceSummary);
            dropdown.appendChild(workspace);

            const worktrees = new Map();
            for (const entry of workspaceGroup.entries) {
                const cwd = entry[1].cwd || '';
                if (!worktrees.has(cwd)) worktrees.set(cwd, []);
                worktrees.get(cwd).push(entry);
            }
            const worktreeGroups = Array.from(worktrees, ([cwd, items]) => ({
                cwd,
                items,
                label: cwd ? projectWorktreeLabel(cwd) : 'No directory',
            }));
            const worktreeLabelCounts = new Map();
            for (const group of worktreeGroups) {
                worktreeLabelCounts.set(
                    group.label,
                    (worktreeLabelCounts.get(group.label) || 0) + 1,
                );
            }

            const orderedWorktreeGroups = [
                ...worktreeGroups.filter((group) => hasUnread(group.items)),
                ...worktreeGroups.filter((group) => !hasUnread(group.items)),
            ];
            for (const worktreeGroup of orderedWorktreeGroups) {
                const cwd = worktreeGroup.cwd;
                const worktree = document.createElement('details');
                worktree.className = 'tab-overflow-worktree';
                worktree.dataset.workspace = workspaceGroup.workspace;
                worktree.dataset.cwd = cwd;
                worktree.dataset.overflowGroupKey = JSON.stringify([
                    'worktree',
                    workspaceGroup.workspace,
                    cwd,
                ]);
                worktree.open = true;
                const worktreeSummary = document.createElement('summary');
                worktreeSummary.dataset.overflowFocusKey =
                    worktree.dataset.overflowGroupKey;
                if (cwd) worktreeSummary.title = cwd;
                const chevron = document.createElement('span');
                chevron.className = 'tab-overflow-chevron';
                chevron.setAttribute('aria-hidden', 'true');
                chevron.textContent = '›';
                const glyph = document.createElement('span');
                glyph.className = 'tab-overflow-worktree-glyph';
                glyph.setAttribute('aria-hidden', 'true');
                glyph.textContent =
                    worktreeGroup.items[0][1].tabEl?.dataset.worktreeGlyph ||
                    worktreeGlyph(cwd);
                const worktreeLabel = document.createElement('span');
                worktreeLabel.className = 'tab-overflow-summary-label';
                worktreeLabel.textContent =
                    cwd && worktreeLabelCounts.get(worktreeGroup.label) > 1
                        ? cwd
                        : worktreeGroup.label;
                const worktreeCount = document.createElement('span');
                worktreeCount.className = 'tab-overflow-count';
                worktreeCount.textContent = `${worktreeGroup.items.length} tab${worktreeGroup.items.length === 1 ? '' : 's'}`;
                worktreeSummary.append(
                    chevron,
                    glyph,
                    worktreeLabel,
                    worktreeCount,
                );
                if (hasUnread(worktreeGroup.items)) {
                    worktree.classList.add('has-attention');
                    worktreeSummary.appendChild(
                        this._makeAttentionMarker(
                            'tab-overflow-attention',
                            'Contains tabs needing attention',
                        ),
                    );
                }
                worktree.appendChild(worktreeSummary);
                workspace.appendChild(worktree);
                const orderedItems = [
                    ...worktreeGroup.items.filter(
                        ([, tab]) => tab.isAttention,
                    ),
                    ...worktreeGroup.items.filter(
                        ([, tab]) => !tab.isAttention,
                    ),
                ];
                for (const [paneId, tab] of orderedItems) {
                    appendRow(worktree, paneId, tab);
                }
            }
        }

        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tab-overflow-empty';
            empty.textContent = 'No tabs open';
            dropdown.appendChild(empty);
        }

        if (preserveState) {
            for (const disclosure of dropdown.querySelectorAll(
                'details[data-overflow-group-key]',
            )) {
                disclosure.open = !collapsedKeys.has(
                    disclosure.dataset.overflowGroupKey,
                );
            }
            dropdown.scrollTop = savedScrollTop;
            if (focusedPopup) {
                dropdown.focus({ preventScroll: true });
            } else if (focusedKey) {
                const matching = Array.from(
                    dropdown.querySelectorAll('[data-overflow-focus-key]'),
                ).find(
                    (element) =>
                        element.dataset.overflowFocusKey === focusedKey,
                );
                const isVisible = (element) => {
                    for (
                        let ancestor = element.parentElement;
                        ancestor && ancestor !== dropdown;
                        ancestor = ancestor.parentElement
                    ) {
                        if (
                            ancestor instanceof HTMLDetailsElement &&
                            !ancestor.open &&
                            !(element instanceof HTMLElement &&
                                element.tagName === 'SUMMARY' &&
                                element.parentElement === ancestor)
                        ) {
                            return false;
                        }
                    }
                    return true;
                };
                if (matching && isVisible(matching)) {
                    matching.focus({ preventScroll: true });
                } else {
                    const visible = (element) => isVisible(element);
                    const liveRows = Array.from(
                        dropdown.querySelectorAll(
                            '.hostname-dropdown-row:not(.tab-overflow-closing-row)',
                        ),
                    ).filter(visible);
                    const activeRow = liveRows.find((row) =>
                        row.classList.contains('active'),
                    );
                    const fallback =
                        activeRow?.querySelector(
                            '.hostname-dropdown-select-btn',
                        ) ||
                        liveRows[0]?.querySelector(
                            '.hostname-dropdown-select-btn',
                        ) ||
                        Array.from(
                            dropdown.querySelectorAll(
                                '.tab-overflow-closing-row .hostname-dropdown-select-btn',
                            ),
                        ).find(visible) ||
                        dropdown;
                    fallback.focus({ preventScroll: true });
                }
            }
        }
        return dropdown;
    }

    _overflowDropdownHidden() {
        const dd = document.getElementById('tab-overflow-dropdown');
        return !dd || dd.classList.contains('hidden');
    }

    _focusOverflowDropdownOnOpen(dropdown) {
        const activeRow = dropdown.querySelector(
            '.hostname-dropdown-row.active:not(.tab-overflow-closing-row)',
        );
        const firstLiveRow = dropdown.querySelector(
            '.hostname-dropdown-row:not(.tab-overflow-closing-row)',
        );
        const undoButton = dropdown.querySelector(
            '.tab-overflow-closing-row .hostname-dropdown-select-btn',
        );
        const row = activeRow || firstLiveRow;
        const target =
            row?.querySelector('.hostname-dropdown-select-btn') ||
            undoButton ||
            dropdown;
        target.focus({ preventScroll: true });
        const targetRow = target.closest('.hostname-dropdown-row');
        targetRow?.scrollIntoView?.({ block: 'nearest' });
    }

    _toggleOverflowDropdown() {
        const dd = document.getElementById('tab-overflow-dropdown');
        const btn = document.getElementById('tab-overflow-btn');
        if (!dd || !btn) return;
        const open = dd.classList.contains('hidden');
        if (open) {
            this._buildOverflowDropdown();
            dd.classList.remove('hidden');
            btn.setAttribute('aria-expanded', 'true');
            this._focusOverflowDropdownOnOpen(dd);
        } else {
            this._closeOverflowDropdown();
        }
    }

    _closeOverflowDropdown({ restoreFocus = false } = {}) {
        const dd = document.getElementById('tab-overflow-dropdown');
        const btn = document.getElementById('tab-overflow-btn');
        if (dd) dd.classList.add('hidden');
        if (btn) btn.setAttribute('aria-expanded', 'false');
        if (restoreFocus) btn?.focus({ preventScroll: true });
    }

    sendInput(tabInfo, payload) {
        // Every PTY writer passes here, including direct terminal typing.
        this._resetPiRecall({ flush: true });
        if (!tabInfo?.ws || tabInfo.isDead) {
            this.app.showToast('Tab is disconnected — input not sent', {
                type: 'error',
            });
            if (tabInfo) this._showReconnectOverlay(tabInfo);
            return false;
        }

        // Track user-initiated commands and cancellation
        if (typeof payload === 'string') {
            if (payload === '\x03' || payload === '\x14') {
                tabInfo.userTaskActive = false;
                tabInfo.busyStartTime = null;
            } else if (payload.includes('\r') || payload.includes('\n')) {
                tabInfo.userTaskActive = true;
                tabInfo.userTaskStartTime = Date.now();
            }
        }

        const ok = tabInfo.ws.sendInput(payload);
        if (!ok) {
            this.app.showToast('Tab is disconnected — input not sent', {
                type: 'error',
            });
            this._showReconnectOverlay(tabInfo);
            return false;
        }
        return true;
    }

    // _initAttachmentDropZone wires drag-and-drop file ingestion. The drop
    // zone is intentionally broader than just the input bar: users drop
    // where their cursor is, which is usually the terminal pane, not the
    // narrow input strip. The page-wide dragover handler gives visual
    // feedback (input bar glows) regardless of cursor position. The
    // drop handler routes file drops from anywhere except the tabs
    // strip (which has its own reorder handler) to the attachment
    // pipeline.
    //
    // Visual feedback: input bar glows via `.is-drop-target` whenever a
    // file is being dragged anywhere on the page. Uses existing --accent
    // tokens — no new colours per AGENTS.md.
    _initAttachmentDropZone() {
        if (!this.inputBarContainer) return;

        // Page-wide dragover: prevent default (required so drop fires)
        // and toggle the visual feedback class on the input bar.
        // Skip when the drag isn't a file (text/uri-list no-op cleanly).
        const isFileDrag = (e) => {
            const dt = e.dataTransfer;
            if (!dt?.types) return false;
            return Array.from(dt.types).includes('Files');
        };

        document.addEventListener('dragover', (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            try {
                e.dataTransfer.dropEffect = 'copy';
            } catch (_) {}
            this.inputBarContainer.classList.add('is-drop-target');
        });

        // dragleave fires on every child boundary; gate by counter so
        // moving across the page keeps the glow on.
        let dragDepth = 0;
        document.addEventListener('dragenter', (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            dragDepth += 1;
            this.inputBarContainer.classList.add('is-drop-target');
        });
        document.addEventListener('dragleave', (_e) => {
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) {
                this.inputBarContainer.classList.remove('is-drop-target');
            }
        });
        document.addEventListener('drop', async (e) => {
            // Skip if the drop landed inside a tab — the per-tab drop
            // handler manages tab reordering. Use closest('.tab') rather
            // than a stored tabsContainer reference so this check stays
            // correct across TabManager instances and test resets.
            if (e.target?.closest?.('.tab')) return;
            if (!isFileDrag(e)) return;
            e.preventDefault();
            dragDepth = 0;
            this.inputBarContainer.classList.remove('is-drop-target');
            const files = extractImageFiles(e.dataTransfer.files);
            for (const file of files) {
                try {
                    const attachment = await uploadClipboardImage(
                        file,
                        file.name || 'dropped',
                    );
                    attachment.source = 'drop';
                    this._addAttachmentChip(attachment);
                } catch (err) {
                    this._attachmentToast(`Drop failed: ${err.message}`);
                }
            }
        });
    }

    // _initAttachmentPasteHandler intercepts image-bearing pastes on the
    // textarea. Text-only pastes fall through to default behavior so
    // pasting a URL into the prompt still works normally.
    //
    // The handler is on the textarea, NOT document — if focus is on the
    // terminal pane, Cmd+V flows raw bytes into the PTY as before. This
    // is the only correct way to not break paste-in-terminal.
    _initAttachmentPasteHandler() {
        if (!this.inputTextArea) return;
        this.inputTextArea.addEventListener('paste', async (e) => {
            const items = extractImageItems(e.clipboardData);
            if (items.length === 0) return; // text paste → let browser handle
            e.preventDefault();
            for (const item of items) {
                const blob = item.getAsFile?.();
                if (!blob) continue;
                try {
                    const attachment = await uploadClipboardImage(
                        blob,
                        'clipboard.png',
                    );
                    this._addAttachmentChip(attachment);
                } catch (err) {
                    this._attachmentToast(`Paste failed: ${err.message}`);
                }
            }
        });
    }

    // (Removed _initDocumentDropGuard: the page-wide dragover/drop handlers
    // in _initAttachmentDropZone now do both preventDefault AND the upload
    // in one place, so a separate "guard" listener is redundant.)

    // _initPromptHistoryKeydown wires Alt+Up / Alt+Down on the staged
    // input textarea to cycle through previously-sent prompts (see
    // _cyclePromptHistory). Kept as its own listener — separate from the
    // big Enter/Escape/arrows keydown handler — so it's easy to unit-test
    // in isolation, matching the _initAttachmentDropZone /
    // _initAttachmentPasteHandler pattern.
    _initPromptHistoryKeydown() {
        if (!this.inputTextArea) return;
        this.inputTextArea.addEventListener('keydown', (e) => {
            if (
                e.key === 'ArrowUp' &&
                e.altKey &&
                !e.shiftKey &&
                !e.ctrlKey &&
                !e.metaKey
            ) {
                e.preventDefault();
                this._cyclePromptHistory('older');
                return;
            }
            if (
                e.key === 'ArrowDown' &&
                e.altKey &&
                !e.shiftKey &&
                !e.ctrlKey &&
                !e.metaKey
            ) {
                e.preventDefault();
                this._cyclePromptHistory('newer');
                return;
            }
        });
        // Any user-typed character breaks the history-cycle: the
        // textarea is now the user's own draft, not a stored entry.
        // Cursor goes back to -1 so the next Alt+Up starts from the
        // most-recent stored entry.
        this.inputTextArea.addEventListener('input', () => {
            this._historyCursor = -1;
            // Typed input also abandons a Pi recall cycle: the draft is
            // the user's own now, and a deferred arrow flushes to the
            // PTY first so the keypress is never lost.
            this._resetPiRecall({ flush: true });
            // Typed input also breaks the per-chat cycle on Pi RPC tabs.
            const typedTab = this.getActiveTab();
            if (typedTab?.coder === 'pi-rpc') {
                typedTab.chatHistoryCursor = -1;
                typedTab.chatHistoryPreCycleValue = undefined;
            }
        });
    }

    // _addAttachmentChip stores the attachment and re-renders the strip.
    _addAttachmentChip(attachment) {
        // De-dupe by path: same file dropped twice shouldn't chip twice.
        if (this.stagedAttachments.some((a) => a.path === attachment.path))
            return;
        this.stagedAttachments.push(attachment);
        this.saveActiveDraft();
        this._renderAttachmentStrip();
    }

    // _removeAttachmentChip removes a single attachment by id.
    _removeAttachmentChip(id) {
        this.stagedAttachments = this.stagedAttachments.filter(
            (a) => a.id !== id,
        );
        this.saveActiveDraft();
        this._renderAttachmentStrip();
    }

    // _renderAttachmentStrip repaints the chip strip from stagedAttachments.
    // Idempotent — called on add/remove/send.
    _renderAttachmentStrip() {
        if (!this.attachmentStrip) return;
        this.attachmentStrip.innerHTML = '';
        if (this.stagedAttachments.length === 0) {
            this.attachmentStrip.classList.add('hidden');
            return;
        }
        this.attachmentStrip.classList.remove('hidden');
        for (const a of this.stagedAttachments) {
            const chip = document.createElement('span');
            chip.className = 'attachment-chip';
            chip.setAttribute('data-id', a.id);
            chip.title = a.path;

            const icon = document.createElement('span');
            icon.className = 'attachment-icon';
            icon.textContent = a.source === 'paste' ? '⎘' : '⎗';
            chip.appendChild(icon);

            const name = document.createElement('span');
            name.className = 'attachment-name';
            name.textContent = formatChipName(a.name, 40);
            chip.appendChild(name);

            const size = document.createElement('span');
            size.className = 'attachment-size';
            size.textContent = this._formatSize(a.sizeBytes);
            chip.appendChild(size);

            const remove = document.createElement('button');
            remove.className = 'attachment-remove';
            remove.setAttribute('aria-label', 'Remove attachment');
            remove.textContent = '✕';
            remove.addEventListener('click', () =>
                this._removeAttachmentChip(a.id),
            );
            chip.appendChild(remove);

            this.attachmentStrip.appendChild(chip);
        }
    }

    _formatSize(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) return '';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    _attachmentToast(message) {
        if (this.app && typeof this.app.showToast === 'function') {
            this.app.showToast(message, {
                type: 'error',
                title: 'Attachments',
            });
        } else {
            console.warn('[attachments]', message);
        }
    }

    // _initBrandHud wires hover/focus on the top-left Φ logo to open the
    // self-state HUD popover. No fetch on open/close — every field is
    // computed from local state (hostname, version, tab map, CPU sample).
    //
    // The popover lives in index.html as a sibling of .brand inside
    // .app-header, but on init we reparent it to <body> so it escapes
    // .app-header's z-index:100 stacking context. Without that reparent,
    // .diff-panel (z-index:1200) and .modal-overlay (z-index:10000)
    // cover the popover and steal its hover events.
    _initBrandHud() {
        const brand = document.querySelector('.brand');
        if (!brand) return;
        this.brandEl = brand;
        // Make the brand discoverable as interactive for keyboard users.
        if (!brand.hasAttribute('tabindex'))
            brand.setAttribute('tabindex', '0');
        if (!brand.hasAttribute('role')) brand.setAttribute('role', 'button');
        if (!brand.getAttribute('aria-describedby')) {
            brand.setAttribute('aria-describedby', 'self-hud-popover');
        }

        // Reparent the popover to <body> so its z-index competes in the
        // root stacking context. Idempotent — no-op if already there.
        if (this.selfHudEl && this.selfHudEl.parentNode !== document.body) {
            document.body.appendChild(this.selfHudEl);
        }

        // Reopen cooldown: ignore open triggers (mouseenter / focus) for
        // this many ms after a close. Prevents the flicker race where the
        // HUD closes (e.g. on outside-click), the cursor happens to be
        // still over the brand, and the next mouseenter reopens it.
        let lastClosedAt = 0;
        const HUD_REOPEN_COOLDOWN_MS = 200;

        const open = () => {
            if (this.selfHudCloseTimer) {
                clearTimeout(this.selfHudCloseTimer);
                this.selfHudCloseTimer = null;
            }
            if (Date.now() - lastClosedAt < HUD_REOPEN_COOLDOWN_MS) return;
            // The sessions slide-out owns the left of the screen while
            // open, and the brand-anchored HUD floats above it (z-index
            // 9999). Refuse to open until the drawer closes — on touch
            // this is the tap path, on mouse the hover path; both funnel
            // here.
            const sidebar = document.getElementById('sidebar-panel');
            if (sidebar?.classList.contains('drawer-open')) return;
            this._renderSelfHud();
            this._openSelfHud();
        };
        const scheduleClose = (delay = 150) => {
            if (this.selfHudCloseTimer) clearTimeout(this.selfHudCloseTimer);
            // Stamp lastClosedAt immediately so any subsequent mouseenter
            // during the fade-out falls inside the cooldown window.
            lastClosedAt = Date.now();
            this.selfHudCloseTimer = setTimeout(() => {
                this.selfHudCloseTimer = null;
                this._closeSelfHud();
            }, delay);
        };
        // closeNow is the "no-grace" close path: clears any pending timer,
        // stamps the cooldown, and closes synchronously. Used by every
        // close trigger except the mouseleave scheduler.
        const closeNow = () => {
            if (this.selfHudCloseTimer) {
                clearTimeout(this.selfHudCloseTimer);
                this.selfHudCloseTimer = null;
            }
            lastClosedAt = Date.now();
            this._closeSelfHud();
        };
        // Expose closeNow so hostname-click and other consumers don't
        // need to duplicate the cooldown bookkeeping.
        this._closeSelfHudNow = closeNow;

        brand.addEventListener('mouseenter', open);
        brand.addEventListener('focus', open);
        brand.addEventListener('mouseleave', () => scheduleClose());
        brand.addEventListener('blur', () => scheduleClose(0));

        // Hovering the hostname area must NOT open the HUD — the hostname
        // has its own click behavior (toggles the tab-selector dropdown)
        // and a HUD + tab-selector both opening would clash visually.
        // Close any open HUD when the cursor enters the hostname wrapper,
        // whether via direct entry or lateral movement from the logo.
        const hostnameWrapper = brand.querySelector('.hostname-wrapper');
        if (hostnameWrapper) {
            hostnameWrapper.addEventListener('mouseenter', () => {
                if (this.selfHudOpen) closeNow();
            });
        }

        // Keep the popover open if the cursor moves onto it (grace period).
        if (this.selfHudEl) {
            this.selfHudEl.addEventListener('mouseenter', () => {
                if (this.selfHudCloseTimer) {
                    clearTimeout(this.selfHudCloseTimer);
                    this.selfHudCloseTimer = null;
                }
            });
            this.selfHudEl.addEventListener('mouseleave', () =>
                scheduleClose(),
            );
        }

        // Track scroll/resize while open so the popover follows the brand
        // when the layout shifts. capture:true ensures we catch scrolls on
        // any container (not just window). passive:true keeps it cheap.
        if (this.selfHudEl) {
            window.addEventListener(
                'scroll',
                () => {
                    if (this.selfHudOpen) this._positionSelfHud();
                },
                { capture: true, passive: true },
            );
            window.addEventListener('resize', () => {
                if (this.selfHudOpen) this._positionSelfHud();
            });
        }

        // Esc closes the popover if focus is on the brand. Listening on
        // brand (not document) keeps scope narrow and avoids leaking
        // listeners across test instances.
        brand.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.selfHudOpen) {
                e.preventDefault();
                closeNow();
                brand.focus({ preventScroll: true });
            }
        });

        // Touch-only click toggle: on devices without hover (phones,
        // tablets), tap brand to open, tap again to close. On
        // mouse-driven devices, hover owns opening/closing; clicks pass
        // through to the outside-click handler below.
        const isTouch =
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(hover: none)').matches;
        if (isTouch) {
            brand.addEventListener('click', (e) => {
                if (e.target.closest('button, .hostname-wrapper')) return;
                if (this.selfHudOpen) closeNow();
                else open();
            });
        }

        // Outside-click closes. Clicks inside the brand or the popover
        // are skipped (the brand's own click handler is responsible for
        // those, and we don't want to fight with it).
        document.addEventListener('click', (e) => {
            if (!this.selfHudOpen) return;
            const t = e.target;
            if (
                t.closest &&
                (t.closest('.brand') || t.closest('#self-hud-popover'))
            )
                return;
            closeNow();
        });
    }

    _openSelfHud() {
        if (!this.selfHudEl) return;
        this._positionSelfHud();
        this.selfHudEl.classList.remove('hidden');
        this.selfHudEl.classList.add('is-open');
        this.selfHudEl.setAttribute('aria-hidden', 'false');
        this.selfHudOpen = true;
    }

    // _positionSelfHud anchors the popover to the brand's current
    // viewport rect. Called on every open and on scroll/resize while
    // open. Inline style.top/.left beat any CSS rule, which is what
    // we want for dynamic positioning.
    _positionSelfHud() {
        if (!this.selfHudEl || !this.brandEl) return;
        const rect = this.brandEl.getBoundingClientRect();
        this.selfHudEl.style.top = `${Math.round(rect.bottom + 10)}px`;
        this.selfHudEl.style.left = `${Math.round(rect.left)}px`;
    }

    _closeSelfHud() {
        if (!this.selfHudEl) return;
        this.selfHudEl.classList.remove('is-open');
        this.selfHudEl.setAttribute('aria-hidden', 'true');
        this.selfHudOpen = false;
        // Hide from layout after the fade-out so it doesn't intercept clicks.
        setTimeout(() => {
            if (!this.selfHudOpen) this.selfHudEl.classList.add('hidden');
        }, 220);
    }

    // _renderSelfHud paints the popover from local state. Pure DOM
    // mutation — no network. Re-run on every open so the values are
    // current as of the most recent open event.
    _renderSelfHud() {
        if (!this.selfHudEl) return;
        const version = this.app?.versionInfo?.version || '';
        const hud = buildSelfHud({
            hostname: this.app?.hostname || '',
            version,
            cpuPercent:
                typeof this.lastCpuPercent === 'number'
                    ? this.lastCpuPercent
                    : null,
            tabs: this.tabs.values(),
        });

        // CPU-driven emphasis class on the popover so the cpu line tints
        // when load climbs. Matches the brand-logo class names.
        const level =
            hud.cpuPercent == null ? 'cpu-idle' : cpuLevel(hud.cpuPercent);
        for (const cls of [
            'cpu-idle',
            'cpu-moderate',
            'cpu-high',
            'cpu-critical',
        ]) {
            this.selfHudEl.classList.remove(cls);
        }
        this.selfHudEl.classList.add(level);

        const workingGlyph =
            hud.busy > 0
                ? '<span class="glyph glyph-working" title="Working">ϕ</span>'
                : '<span class="glyph glyph-idle" title="Idle">Φ</span>';
        const attentionGlyph =
            hud.attention > 0
                ? '<span class="glyph glyph-attention" title="Needs attention">☥</span>'
                : '';

        const versionBit = hud.version
            ? `<span class="self-hud-version">v${escapeHtml(hud.version)}</span>`
            : '';
        const hostBit = hud.hostname
            ? `<span class="glyph">Φ</span><span class="self-hud-host-name">${escapeHtml(hud.hostname)}</span>`
            : '<span class="glyph">Φ</span><span class="self-hud-host-name">phi</span>';

        this.selfHudEl.innerHTML = `
            <div class="self-hud-header">
                <span class="self-hud-host">${hostBit}</span>
                ${versionBit}
            </div>
            <div class="self-hud-rule" aria-hidden="true"></div>
            <div class="self-hud-metrics">
                <span class="metric">
                    <span class="metric-count">${hud.sessions}</span>
                    <span class="metric-label">session${hud.sessions === 1 ? '' : 's'}</span>
                </span>
                <span class="metric glyph-working">
                    ${workingGlyph}
                    <span class="metric-count">${hud.busy}</span>
                    <span class="metric-label">working</span>
                </span>
                ${
                    hud.attention > 0
                        ? `
                <span class="metric glyph-attention">
                    ${attentionGlyph}
                    <span class="metric-count">${hud.attention}</span>
                    <span class="metric-label">attention</span>
                </span>`
                        : ''
                }
            </div>
            <div class="self-hud-footer">
                <span class="cpu">${escapeHtml(formatHudCpu(hud))}</span>
                <span class="dim">${escapeHtml(formatHudLine(hud))}</span>
            </div>
        `;
    }

    sendStagedInput() {
        const activeTab = this.getActiveTab();
        if (!activeTab) return;

        const val = this.inputTextArea.value;
        const attachments = this.stagedAttachments;
        // Empty guard now also allows attachments-only sends. Without
        // this, "drop a screenshot, hit Send with no text" silently
        // does nothing — a confusing dead end.
        if (!val && attachments.length === 0) return;

        // A send abandons Pi recall; a deferred arrow flushes first so
        // Pi sees the keys in the order they were pressed.
        this._resetPiRecall({ flush: true });

        // Compose payload: text first (if any), then one formatted
        // attachment path per line. Path formatting is per-active-tab
        // coder (claude → @path, bash → raw path).
        const coder = activeTab.coder;
        const lines = [];
        if (val?.trim()) lines.push(val.trim());
        for (const a of attachments) {
            lines.push(formatAttachment(coder, a));
        }
        let payload = lines.join('\n');

        if (coder === 'pi-rpc') {
            if (!rpcChatSend(activeTab.paneId, payload)) {
                this.app.showToast('pi chat: not ready', { type: 'error' });
                return;
            }
            // Per-chat, in-memory, current-session history for plain Up/Down
            // recall. Newest-first, consecutive duplicates skipped, capped at
            // 100 like the server-side store. Lives on the tab, dies with it;
            // Reset Chat clears it (see the reset handler in _renderPiRpcPresets).
            if (!Array.isArray(activeTab.promptHistory))
                activeTab.promptHistory = [];
            if (activeTab.promptHistory[0] !== payload) {
                activeTab.promptHistory.unshift(payload);
                if (activeTab.promptHistory.length > 100)
                    activeTab.promptHistory.length = 100;
            }
            activeTab.chatHistoryCursor = -1;
            activeTab.chatHistoryPreCycleValue = undefined;
        } else {
            // Wrap in bracketed paste markers for large prompts or multiline text
            // to prevent TUI trickle-rendering / autocomplete lagging.
            // Codex requires bracketed paste even for short prompts so that
            // inline autocomplete does not intercept keystrokes / Enter.
            if (
                coder === 'codex' ||
                payload.length > 16 ||
                payload.includes('\n')
            ) {
                payload = `\x1b[200~${payload}\x1b[201~`;
            }

            // No isDead pre-check: sendInput() toasts + shows the reconnect overlay on failure.
            const sent = this.sendInput(activeTab, `${payload}\r`);
            if (!sent) return;
        }

        // Record this prompt into ~/.phi/prompt_history.json BEFORE
        // clearing the textarea. Fire-and-forget so a slow disk
        // doesn't hold up the send. The backend handles dedup / cap
        // (FIFO at 100 entries, per-cwd filter).
        const sentText = val?.trim() ? val.trim() : '';
        if (sentText) {
            const cwdForHistory = this.app.sessionsManager?.activeCWD || '';
            fetch('/api/prompt-history/append', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: sentText, cwd: cwdForHistory }),
            }).catch((err) =>
                console.warn('[prompt_history] append failed', err),
            );
            // Reset history cursor — user just sent fresh text, cycling
            // should start back at the most-recent prior entry.
            this._historyCursor = -1;
        }

        this.inputTextArea.value = '';
        this.lastInputValue = '';
        this.stagedAttachments = [];
        this.saveActiveDraft();
        this._renderAttachmentStrip();
        this.adjustInputHeight();
        this._spamScrollToBottom(activeTab);

        // Auto sync clipboard on /copy command
        if (val?.includes('/copy')) {
            setTimeout(() => {
                this.app.syncRemoteClipboard();
            }, 300);
        }

        this.inputTextArea.focus({ preventScroll: true });
    }

    sendRawInput(bytes, { focusInputOnMobile = true } = {}) {
        const activeTab = this.getActiveTab();
        if (!activeTab || activeTab.coder === 'pi-rpc') return;
        // The backend PTY layer handles the Windows ConPTY quirk where a \r
        // bundled with preceding text fails to register as Enter — see pkg/pty.
        const sent = this.sendInput(activeTab, bytes);
        if (!sent) return;

        const isMobile = prefersInputBarFocus();
        if (isMobile) {
            if (focusInputOnMobile && !activeTab.directMode && this.inputTextArea) {
                this.inputTextArea.focus({ preventScroll: true });
            } else {
                this.inputTextArea?.blur();
            }
        } else {
            this.focusActiveTerminal();
        }

        this._spamScrollToBottom(activeTab);

        // Auto sync clipboard on /copy command
        if (bytes.includes('/copy')) {
            setTimeout(() => {
                this.app.syncRemoteClipboard();
            }, 300);
        }
    }

    /**
     * Send input to a SPECIFIC tab — does NOT re-resolve the active tab.
     * Thin wrapper over sendInput() (which owns the disconnect toast +
     * reconnect overlay) plus the scroll follow-up. Deliberately does NOT
     * steal focus — delayed callbacks must not refocus a tab the user has
     * switched away from. Use from setTimeout chains or anywhere the
     * active tab may have changed between scheduling and firing.
     */
    sendToTab(tabInfo, payload) {
        const sent = this.sendInput(tabInfo, payload);
        if (sent) this._spamScrollToBottom(tabInfo);
        return sent;
    }

    /**
     * Raw key→PTY forwarding shared by the staged-input bar (when empty),
     * the terminal's custom key handler (non-direct mode), and the mobile
     * document-level fallback. Maps a keydown to the bytes the PTY expects
     * and sends them via sendToTab (no focus steal — callers own focus).
     * Consumes a matched key (preventDefault) even without an active tab,
     * mirroring the original staged-input map. Returns true when consumed.
     * Emptiness/modifier gates are caller concerns, not decided here.
     */
    _forwardKeyToPty(e, tab) {
        if (tab?.coder === 'pi-rpc') return false;
        if (e.isComposing) return false; // never emit bytes mid-IME composition
        let sendChar = null;
        // Shift+Tab (Backtab) — also prevents the browser focus shift.
        if (e.key === 'Tab' && e.shiftKey) {
            sendChar = '\x1b[Z';
        } else {
            const keys = {
                ArrowUp: '\u001b[A',
                ArrowDown: '\u001b[B',
                ArrowLeft: '\u001b[D',
                ArrowRight: '\u001b[C',
                PageUp: '\u001b[5~',
                PageDown: '\u001b[6~',
                Home: '\u001b[H',
                End: '\u001b[F',
                Delete: '\u001b[3~',
                Tab: '\t',
                Enter: '\r',
                Escape: '\x1b',
                Backspace: '\x7f',
            };
            if (keys[e.key]) {
                sendChar = keys[e.key];
            } else if (e.ctrlKey) {
                const ctrlKeys = {
                    c: '\x03',
                    o: '\x0f',
                    p: '\x10',
                    t: '\x14',
                };
                const lowerKey = e.key.toLowerCase();
                if (ctrlKeys[lowerKey]) {
                    sendChar = ctrlKeys[lowerKey];
                }
            }
        }
        if (sendChar === null) return false;
        e.preventDefault();
        if (tab) this.sendToTab(tab, sendChar);
        return true;
    }

    /**
     * Legacy OpenCode can discard Enter while updating a pasted command.
     * Keep its 200ms gap pinned to the clicked tab. V2 Mini queues Enter
     * behind a pending paste, so it uses the atomic form, like Pi.
     */
    sendSlashCommand(tabInfo, cmd, { focusInputOnMobile = true } = {}) {
        if (tabInfo?.coder === 'pi-rpc') return false;
        // An obsolete exact-Compact target dispatches nowhere: the tab
        // object is no longer the pane's current session, so neither
        // the native API nor the legacy PTY paste may fire from it.
        // (sendInput never checks map membership, so merely failing
        // eligibility would still PTY-send.) Other commands and
        // backends keep legacy behavior.
        if (
            cmd === '/compact' &&
            tabInfo?.coder === 'pi' &&
            this.tabs &&
            this.tabs.get(tabInfo.paneId) !== tabInfo
        )
            return true;
        // Exact /compact on a capable ordinary Pi tab takes the native
        // bridge path; anything incapable keeps the legacy paste+Enter.
        // Eligibility precedes every native guard, so a later click
        // while disconnected still reaches the legacy PTY action even
        // when an old HTTP request is still pending.
        if (
            cmd === '/compact' &&
            tabInfo?.coder === 'pi' &&
            this._piBridgeCompactEligible(tabInfo)
        ) {
            return this._sendPiBridgeCompact(tabInfo, {
                focusInputOnMobile,
            });
        }
        const paste = `\x1b[200~${cmd}\x1b[201~`;
        const legacyOpenCode = tabInfo.coder === 'opencode' && !isOpenCodeMini(tabInfo);
        const sent = this.sendToTab(
            tabInfo,
            legacyOpenCode ? paste : `${paste}\r`,
        );
        if (!sent) return false;
        if (legacyOpenCode) {
            setTimeout(() => {
                this.sendToTab(tabInfo, '\r');
            }, 200);
        }
        this._focusAfterSlashCommand(tabInfo, focusInputOnMobile);
        return true;
    }

    // _focusAfterSlashCommand keeps one focus tail for the legacy and
    // native slash paths: mobile honors the caller's focus option and
    // desktop returns to the terminal.
    _focusAfterSlashCommand(tabInfo, focusInputOnMobile) {
        const isMobile = prefersInputBarFocus();
        if (isMobile) {
            if (focusInputOnMobile && !tabInfo.directMode && this.inputTextArea) {
                this.inputTextArea.focus({ preventScroll: true });
            } else {
                this.inputTextArea?.blur();
            }
        } else {
            this.focusActiveTerminal();
        }
    }

    // _sendPiBridgeCompact runs the native bridge path for an exact
    // /compact on a capable Pi PTY tab. Always handled (true): guards
    // swallow without PTY fallback, and a dispatch never replays on
    // refusal, error, timeout, or disconnect. Draft and attachments
    // are never touched here; focus matches the legacy slash path.
    _sendPiBridgeCompact(tabInfo, { focusInputOnMobile = true } = {}) {
        const paneId = tabInfo.paneId;
        // One native request per pane; a duplicate desktop/mobile
        // click while one is pending is swallowed, never replayed.
        if (this._piBridgeCompactPending?.get(paneId)) return true;
        const view = tabInfo.piBridge;
        // Eligible but busy or unknown: send NEITHER api nor PTY.
        if (!piBridgeCompactReady(view).ready) return true;
        const controller = new AbortController();
        const op = {
            tab: tabInfo,
            ws: tabInfo.ws,
            generation: view.generation,
            paneId,
            controller,
            timer: null,
        };
        if (!this._piBridgeCompactPending)
            this._piBridgeCompactPending = new Map();
        this._piBridgeCompactPending.set(paneId, op);
        // The timer finalizes directly: a dropped response still
        // reports unknown even when fetch ignores the abort signal.
        op.timer = setTimeout(() => {
            controller.abort();
            this._finalizePiBridgeCompact(op, { kind: 'unknown' });
        }, PI_BRIDGE_COMPACT_TIMEOUT_MS);
        let request;
        try {
            request = fetch('/api/pi-bridge/compact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pane: paneId,
                    generation: view.generation,
                    telemetry_revision: view.telemetry_revision,
                }),
                signal: controller.signal,
                cache: 'no-store',
            });
        } catch (error) {
            request = Promise.reject(error);
        }
        Promise.resolve(request).then(
            (res) => {
                let parsed = null;
                try {
                    parsed =
                        typeof res?.json === 'function' ? res.json() : null;
                } catch {
                    parsed = null;
                }
                return Promise.resolve(parsed)
                    .catch(() => null)
                    .then((json) => ({ res, json }));
            },
            () => ({ res: null, json: null }),
        ).then(({ res, json }) =>
            this._finalizePiBridgeCompact(
                op,
                this._piBridgeCompactOutcome(res, json),
            ),
        );
        this._refreshPiBridgeModels(tabInfo);
        this._focusAfterSlashCommand(tabInfo, focusInputOnMobile);
        return true;
    }

    // _piBridgeCompactOutcome maps one Compact HTTP round trip to a
    // safe outcome. Only the exact server vocabulary passes: success
    // needs exactly HTTP 200 with completed (a 202 acceptance is
    // still unknown), refusal needs 409/503, failure 502. Anything
    // else — network failure, unparsable body, wrong status — is
    // unknown, never a silent success and never a PTY replay.
    _piBridgeCompactOutcome(res, json) {
        const outcome =
            json && typeof json === 'object' ? json.outcome : null;
        if (res?.status === 200 && outcome === 'completed')
            return { kind: 'completed' };
        if (
            outcome === 'rejected-before-start' &&
            (res?.status === 409 || res?.status === 503)
        )
            return {
                kind: 'refused',
                unavailable: res.status === 503,
                reason: json.reason,
            };
        if (outcome === 'failed' && res?.status === 502)
            return { kind: 'failed', reason: json.reason };
        return { kind: 'unknown' };
    }

    // _finalizePiBridgeCompact settles one native Compact op. A late
    // response for a superseded op, a replaced tab, or a closed pane
    // changes nothing, and a same-tab socket swap or runtime
    // generation move since dispatch also settles silently: the
    // waiter no longer belongs to the live session. Telemetry
    // revision is deliberately NOT fenced — a successful compaction
    // advances it. Only the current op clears itself, and UI updates
    // land only on its live tab. Never PTY-falls back.
    _finalizePiBridgeCompact(op, result) {
        if (op.timer) clearTimeout(op.timer);
        if (this._piBridgeCompactPending?.get(op.paneId) !== op) return;
        this._piBridgeCompactPending.delete(op.paneId);
        if (this.tabs?.get(op.paneId) !== op.tab) return;
        if (op.tab.ws !== op.ws) return;
        if (op.tab.piBridge?.generation !== op.generation) return;
        this._refreshPiBridgeModels(op.tab);
        if (!this.app || typeof this.app.showToast !== 'function') return;
        // The reason must be one fixed vocabulary word; an empty or
        // foreign reason renders the bare message. Word-shaped
        // provider text never reaches the toast.
        const reason =
            typeof result?.reason === 'string' &&
            PI_BRIDGE_COMPACT_REASONS.has(result.reason)
                ? result.reason
                : '';
        const suffix = reason ? `: ${reason}` : '';
        if (result?.kind === 'completed') {
            this.app.showToast('Compaction complete', {
                type: 'success',
                title: 'Compact',
            });
        } else if (result?.kind === 'refused') {
            this.app.showToast(
                result.unavailable
                    ? 'Compaction unavailable'
                    : `Compaction refused${suffix}`,
                { type: 'info', title: 'Compact' },
            );
        } else if (result?.kind === 'failed') {
            this.app.showToast(`Compaction failed${suffix}`, {
                type: 'error',
                title: 'Compact',
            });
        } else {
            this.app.showToast('Compaction outcome unknown', {
                type: 'error',
                title: 'Compact',
            });
        }
    }

    // _invalidatePiBridgeCompact drops the pane's pending native
    // Compact waiter when its dispatch identity no longer holds:
    // socket swapped, runtime generation moved, tab exited, lease
    // restarted, peer lost, or capability revoked. Only the matching
    // waiter is cleared — its timer is cancelled and the HTTP wait
    // aborted, which never cancels accepted server work and never
    // replays or touches a newer op; the aborted wait's late reply
    // finalizes silently. A still-current tab reports the outcome as
    // unknown exactly once when asked (the disconnect path); closed
    // or replaced identities stay silent.
    _invalidatePiBridgeCompact(tabInfo, reportUnknown = false) {
        const paneId = tabInfo?.paneId;
        if (paneId == null) return;
        const op = this._piBridgeCompactPending?.get(paneId);
        if (!op || op.tab !== tabInfo) return;
        if (op.timer) clearTimeout(op.timer);
        op.timer = null;
        this._piBridgeCompactPending.delete(paneId);
        try {
            op.controller?.abort();
        } catch (_abortError) {}
        if (!reportUnknown) {
            this._refreshPiBridgeModels(tabInfo);
            return;
        }
        if (this.tabs?.get(paneId) !== tabInfo) return;
        this._refreshPiBridgeModels(tabInfo);
        if (!this.app || typeof this.app.showToast !== 'function') return;
        this.app.showToast('Compaction outcome unknown', {
            type: 'error',
            title: 'Compact',
        });
    }

    _showReconnectOverlay(tabInfo) {
        const existing =
            tabInfo.termContainer.querySelector('.reconnect-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'reconnect-overlay';

        let msg = 'Connection lost';
        let showReconnect = true;

        if (tabInfo.exitCode !== undefined && tabInfo.exitCode !== null) {
            if (tabInfo.exitCode === -1) {
                msg = 'Session expired (PTY gone)';
                showReconnect = false;
            } else {
                msg = `process exited (code ${tabInfo.exitCode})`;
                showReconnect = false;
            }
        }

        overlay.innerHTML = `
            <div class="reconnect-box">
                <span class="reconnect-msg">${msg}</span>
                <div class="reconnect-buttons">
                    ${showReconnect ? '<button class="reconnect-btn">⟳ Reconnect</button>' : ''}
                    <button class="restart-btn">⚡ Restart</button>
                </div>
            </div>`;

        if (showReconnect) {
            overlay
                .querySelector('.reconnect-btn')
                .addEventListener('click', () => {
                    this.reconnectTab(tabInfo);
                });
        }
        overlay.querySelector('.restart-btn').addEventListener('click', () => {
            this.restartTab(tabInfo);
        });

        tabInfo.termContainer.appendChild(overlay);
    }

    _setCurrentTabSocket(tabInfo, socket) {
        tabInfo._piTitleRevision = -1;
        tabInfo.ws = socket;
        // A new browser socket restarts bridge ordering: never carry
        // the old server's counter across, and drop freshness until
        // current-socket state re-confirms it.
        this._resetPiBridgeOrdered(tabInfo);
        // A swapped socket orphans the pending native Compact waiter:
        // drop it and report unknown once for the still-current tab.
        const pendingOp = this._piBridgeCompactPending?.get(tabInfo.paneId);
        if (
            pendingOp &&
            pendingOp.tab === tabInfo &&
            pendingOp.ws !== tabInfo.ws
        )
            this._invalidatePiBridgeCompact?.(tabInfo, true);
        this._refreshPiBridgeModels(tabInfo);
    }

    // _resetPiBridgeOrdered drops the per-tab publication floor and the
    // current-socket freshness mark. The next valid state re-baselines.
    _resetPiBridgeOrdered(tabInfo) {
        if (!tabInfo) return;
        tabInfo._piBridgeRev = null;
        tabInfo._piBridgeFresh = null;
    }

    // _piBridgeRevValue parses a telemetry revision: a valid positive
    // u64 decimal string yields a BigInt, anything else yields null.
    // Never compare revisions as floats: u64 exceeds safe integers.
    _piBridgeRevValue(raw) {
        if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
        try {
            const value = BigInt(raw);
            if (value <= 0n || value > 18446744073709551615n) return null;
            return value;
        } catch {
            return null;
        }
    }

    // _normalizePiBridgeView maps one HTTP or WS bridge view into the
    // stored shape. HTTP carries booleans/arrays, WS carries strings;
    // both land here so ordering compares one canonical form.
    _normalizePiBridgeView(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const view = {
            state: typeof raw.state === 'string' ? raw.state : 'plain',
        };
        if (typeof raw.reason === 'string' && raw.reason)
            view.reason = raw.reason;
        if (typeof raw.generation === 'string' && raw.generation)
            view.generation = raw.generation;
        if (
            typeof raw.telemetry_revision === 'string' &&
            raw.telemetry_revision
        )
            view.telemetry_revision = raw.telemetry_revision;
        if (typeof raw.last_run === 'string' && raw.last_run)
            view.last_run = raw.last_run;
        if (typeof raw.last_outcome === 'string' && raw.last_outcome)
            view.last_outcome = raw.last_outcome;
        if (raw.running === true || raw.running === 'true')
            view.running = true;
        else if (raw.running === false || raw.running === 'false')
            view.running = false;
        if (raw.connected === true || raw.connected === 'true')
            view.connected = true;
        else if (raw.connected === false || raw.connected === 'false')
            view.connected = false;
        if (typeof raw.model === 'string' && raw.model)
            view.model = raw.model;
        view.thinking_level = PI_BRIDGE_THINKING_LEVELS.includes(
            raw.thinking_level,
        )
            ? raw.thinking_level
            : '';
        const caps = raw.capabilities;
        if (typeof caps === 'string' && caps)
            view.capabilities = caps.split(',').filter(Boolean);
        else if (Array.isArray(caps))
            view.capabilities = caps.filter(
                (c) => typeof c === 'string' && c,
            );
        // Context telemetry: finite nonnegative safe magnitudes, a
        // positive window, and percent only with known tokens. Absent
        // or invalid fields stay unknown; nothing coerces to zero.
        const contextTokens = piBridgeContextNumber(raw.context_tokens);
        const contextWindow = piBridgeContextNumber(raw.context_window);
        const contextPercent = piBridgeContextNumber(raw.context_percent);
        const tokensKnown =
            contextTokens !== null &&
            contextTokens >= 0 &&
            contextTokens <= 9007199254740991;
        const windowKnown =
            contextWindow !== null &&
            contextWindow > 0 &&
            contextWindow <= 9007199254740991;
        if (tokensKnown) view.context_tokens = contextTokens;
        if (windowKnown) view.context_window = contextWindow;
        if (
            tokensKnown &&
            contextPercent !== null &&
            contextPercent >= 0 &&
            contextPercent <= 9007199254740991
        )
            view.context_percent = contextPercent;
        // Compaction readiness arrives as a group: any missing or
        // invalid member leaves the whole sample unknown.
        const compactIdle = piBridgeReadinessBool(raw.compact_idle);
        const compactQueued = piBridgeReadinessBool(raw.compact_queued);
        const compactActive = piBridgeReadinessBool(raw.compact_active);
        const compactPending = piBridgeReadinessBool(raw.compact_pending);
        if (
            compactIdle !== null &&
            compactQueued !== null &&
            compactActive !== null &&
            compactPending !== null
        ) {
            view.compact_idle = compactIdle;
            view.compact_queued = compactQueued;
            view.compact_active = compactActive;
            view.compact_pending = compactPending;
        }
        return view;
    }

    // _acceptOrderedBridgeView applies one HTTP (socket null) or WS
    // bridge view to the per-tab ordered state. A valid positive u64
    // baseline is accepted, then only newer revisions; an equal
    // revision agreeing on every retained identity/state field
    // confirms freshness on the current socket, while a conflicting
    // equal or any older revision is rejected. Unstamped managed
    // views never replace accepted state. Non-managed views apply only when no floor is
    // known. HTTP seeds set the floor but never freshness: the model
    // shows only after current-socket state confirms it.
    _acceptOrderedBridgeView(tabInfo, raw, socket) {
        if (!tabInfo || tabInfo.coder !== 'pi') return false;
        if (this.tabs?.get(tabInfo.paneId) !== tabInfo) return false;
        if (socket !== null && socket !== undefined) {
            if (!socket || tabInfo.ws !== socket) return false;
            if (
                raw &&
                typeof raw === 'object' &&
                raw.pane_id !== undefined &&
                raw.pane_id !== tabInfo.paneId
            )
                return false;
        }
        const view = this._normalizePiBridgeView(raw);
        if (!view) return false;
        if (view.state !== 'managed') {
            if (tabInfo._piBridgeRev != null) return false;
            tabInfo.piBridge = view;
            if (socket) tabInfo._piBridgeFresh = socket;
            return true;
        }
        const rev = this._piBridgeRevValue(view.telemetry_revision);
        if (rev === null) return false;
        const floor = tabInfo._piBridgeRev;
        if (floor == null) {
            tabInfo._piBridgeRev = rev;
            tabInfo.piBridge = view;
            if (socket) tabInfo._piBridgeFresh = socket;
            return true;
        }
        if (rev < floor) return false;
        if (rev === floor) {
            // An equal revision must agree on every retained
            // identity/state field, including the new telemetry; a
            // conflicting equal revision refreshes nothing.
            if (!piBridgeEqualRevAgrees(tabInfo.piBridge, view)) return false;
            const current = tabInfo.piBridge;
            // Availability rides the retained view without a new
            // revision: adopt a flipped connected at equal rev so
            // peer-down still lands.
            if (
                current &&
                view.connected !== undefined &&
                current.connected !== view.connected
            ) {
                current.connected = view.connected;
            }
            if (socket) tabInfo._piBridgeFresh = socket;
            return true;
        }
        tabInfo._piBridgeRev = rev;
        tabInfo.piBridge = view;
        if (socket) tabInfo._piBridgeFresh = socket;
        return true;
    }

    // _seedHttpPiBridge applies one spawn/resume/restore/restart HTTP
    // bridge baseline through the same ordering check as live frames,
    // so a late HTTP response can never overwrite newer WS state.
    _seedHttpPiBridge(tabInfo, httpView) {
        if (!tabInfo || tabInfo.coder !== 'pi') return false;
        const accepted = this._acceptOrderedBridgeView(
            tabInfo,
            httpView,
            null,
        );
        // A baseline can move model or availability like a live frame, but it
        // never reaches _acceptPiBridgeState, so clean up Thinking here.
        if (accepted) this._refreshPiBridgeModels(tabInfo);
        return accepted;
    }

    _acceptPiSessionTitle(tabInfo, control, socket = tabInfo?.ws) {
        if (
            !tabInfo ||
            !socket ||
            tabInfo.ws !== socket ||
            this.tabs.get(tabInfo.paneId) !== tabInfo ||
            tabInfo.coder !== 'pi' ||
            typeof tabInfo.sessionId !== 'string' ||
            tabInfo.sessionId.length === 0 ||
            typeof control.session_id !== 'string' ||
            control.session_id.length === 0 ||
            control.pane_id !== tabInfo.paneId ||
            control.session_id !== tabInfo.sessionId ||
            typeof control.title !== 'string' ||
            control.title.length === 0 ||
            !Number.isSafeInteger(control.revision) ||
            control.revision < 0
        ) {
            return false;
        }
        if (
            Number.isSafeInteger(tabInfo._piTitleRevision) &&
            control.revision < tabInfo._piTitleRevision
        ) {
            return false;
        }
        tabInfo._piTitleRevision = control.revision;
        this._setTabTitle(tabInfo, control.title);
        return true;
    }

    handleControlMessage(tabInfo, control, socket = tabInfo?.ws) {
        if (!control) return;
        if (control.type === 'session-title') {
            this._acceptPiSessionTitle(tabInfo, control, socket);
        } else if (control.type === 'pi-bridge-state') {
            this._acceptPiBridgeState(tabInfo, control, socket);
        } else if (control.type === 'pi-bridge-settled') {
            this._acceptPiBridgeSettled(tabInfo, control);
        } else if (control.type === 'pty-exited') {
            tabInfo.exitCode = control.code;
            tabInfo.isDead = true;
            tabInfo.tabEl.classList.add('dead');
            this.updateDocumentTitle();
            this._showReconnectOverlay(tabInfo);
            // An exit revokes point-of-use eligibility: hide the meter
            // and restore the legacy Compact controls on this tab.
            this._refreshPiBridgeModels(tabInfo);
            // An exit also orphans the pending native Compact waiter:
            // like any other interrupted wait it reports unknown once
            // (PROTOCOL.md), never a silent drop and never a retry.
            this._invalidatePiBridgeCompact?.(tabInfo, true);
        } else if (control.type === 'replay-complete') {
            // An empty replay still ends here, so drop the pending reset or
            // the next live byte would clear the terminal underneath the user.
            tabInfo.awaitingReplay = false;
            if (localStorage.getItem('phi_replay_divider') === 'true') {
                tabInfo.term.write('\r\n\x1b[33m─── live ───\x1b[0m\r\n');
            }
        } else if (control.type === 'output-dropped') {
            // Hot-v1 slow-client warning. Rendered locally —
            // not part of the byte stream, so seq accounting is untouched.
            this.writeToTerminal(
                tabInfo,
                '\r\n\x1b[33m[phi: output dropped — slow client]\x1b[0m\r\n',
            );
        } else if (control.type === 'server-shutdown') {
            // Plan §3.1 / Phase 9: server announces restart/update/shutdown
            // and arms a client-side reload poller. The page reloads when
            // /api/version reports a different stamped version OR after 10s,
            // whichever comes first.
            this.handleServerShutdown(control.reason || 'shutdown');
        } else if (control.type === 'md-changed') {
            // fsnotify push: a watched markdown dir changed on disk. Every
            // open pane WS receives the broadcast, so MarkdownManager
            // debounces client-side.
            if (this.app.markdownManager) {
                this.app.markdownManager.onExternalChange(control);
            }
        } else if (control.type === 'sync-changed') {
            // Real-time Sync Board push: a message was upserted or deleted.
            // Every open pane WS receives the broadcast; SyncManager
            // debounces client-side.
            if (this.app.syncManager?.onSyncChanged) {
                this.app.syncManager.onSyncChanged(control);
            }
        }
    }

    // _acceptPiBridgeState records the per-pane bridge view. The first
    // sight of a retained run establishes a silent baseline (a new browser
    // never bells for history); only a newer run after a baseline rings a
    // catch-up bell. Aborted runs never ring.
    _acceptPiBridgeState(tabInfo, control, socket = tabInfo?.ws) {
        if (!tabInfo || tabInfo.coder !== 'pi') return;
        const prevKeys = this._piBridgeKeys(tabInfo);
        this._acceptOrderedBridgeView(tabInfo, control, socket);
        // A retained view that no longer supports the pending native
        // Compact waiter — runtime generation moved, peer lost, or
        // capability revoked — orphans it silently; the late HTTP
        // reply then finalizes silently too. Inline reads only, so
        // partial harnesses without the waiter surface still pass.
        const pendingOp = this._piBridgeCompactPending?.get(tabInfo.paneId);
        if (
            pendingOp &&
            pendingOp.tab === tabInfo &&
            (tabInfo.ws !== pendingOp.ws ||
                tabInfo.piBridge?.generation !== pendingOp.generation ||
                tabInfo.piBridge?.connected !== true ||
                !(tabInfo.piBridge?.capabilities || []).includes(
                    'pi.compact.v1',
                ))
        )
            // Peer-down or capability loss on the still-current
            // socket/runtime reports unknown once for the live
            // operation; a swapped socket or moved generation is a
            // stale waiter and stays silent.
            this._invalidatePiBridgeCompact?.(
                tabInfo,
                tabInfo.ws === pendingOp.ws &&
                    tabInfo.piBridge?.generation === pendingOp.generation,
            );
        const nextKeys = this._piBridgeKeys(tabInfo);
        // The models trigger, the slash presets, and the Compact
        // controls ride the row key; context occupancy rides the bar
        // alone, so a per-turn telemetry frame never rebuilds the row
        // (and never takes the keyboard user's focus with it).
        // Rejected (stale) frames move neither key.
        if (prevKeys.row !== nextKeys.row) this._refreshPiBridgeModels(tabInfo);
        else if (prevKeys.bar !== nextKeys.bar && this.getActiveTab() === tabInfo)
            this.renderPiRpcStatusBar?.();
        if (
            this._piRecall?.paneId === tabInfo.paneId &&
            (!this._piRecallEligible(tabInfo) ||
                tabInfo.piBridge.generation !== this._piRecall.gen)
        ) {
            this._resetPiRecall({ flush: true });
        }
        // running/last_run only arrive post-hello, so their first
        // sight proves the bridge is live (not merely provisioned).
        if (control.running !== undefined || control.last_run) {
            tabInfo._piBridgeLive = true;
        }
        // Live state with no retained run establishes a zero baseline:
        // the tab was already observing, so a later reconnect snapshot
        // with run 1 must ring instead of silently baselining.
        if (
            !control.last_run &&
            control.running !== undefined &&
            !this._piBridgeHasBaseline(tabInfo)
        ) {
            tabInfo._piBridgeLastRun = '0';
            if (
                typeof control.generation === 'string' &&
                /^\d+$/.test(control.generation)
            ) {
                tabInfo._piBridgeGeneration = control.generation;
            }
        }
        if (
            control.last_run &&
            this._piBridgeRunIsNew(
                tabInfo,
                control.last_run,
                control.generation,
            )
        ) {
            const hadBaseline = this._piBridgeHasBaseline(tabInfo);
            tabInfo._piBridgeLastRun = control.last_run;
            if (
                typeof control.generation === 'string' &&
                /^\d+$/.test(control.generation)
            ) {
                tabInfo._piBridgeGeneration = control.generation;
            }
            if (hadBaseline && control.last_outcome !== 'aborted') {
                this._ringPiBridgeBell(tabInfo);
            }
        }
    }

    // _acceptPiBridgeSettled rings one bell per observed run. Duplicates
    // and aborted runs update the high-water mark without ringing.
    _acceptPiBridgeSettled(tabInfo, control) {
        if (!tabInfo || tabInfo.coder !== 'pi') return;
        if (!control.run) return;
        // Settled frames only arrive post-hello: proof of liveness.
        tabInfo._piBridgeLive = true;
        if (
            !this._piBridgeRunIsNew(
                tabInfo,
                control.run,
                control.generation,
            )
        )
            return;
        tabInfo._piBridgeLastRun = control.run;
        if (
            typeof control.generation === 'string' &&
            /^\d+$/.test(control.generation)
        ) {
            tabInfo._piBridgeGeneration = control.generation;
        }
        // A settlement ends the run, whatever the outcome.
        if (tabInfo.piBridge) tabInfo.piBridge.running = false;
        if (control.outcome === 'aborted') return;
        this._ringPiBridgeBell(tabInfo);
    }

    // Runs and generations are u64 decimal strings; compare numerically,
    // defensively. Ordering is generation-major: any run in a newer
    // generation is new, and any run in an older generation is stale.
    // Frames without a generation fall back to the legacy run-only
    // comparison.
    _piBridgeRunIsNew(tabInfo, run, generation) {
        if (typeof run !== 'string' || !/^\d+$/.test(run)) return false;
        const seen = tabInfo._piBridgeLastRun;
        if (typeof seen !== 'string' || !/^\d+$/.test(seen)) return true;
        const seenGen = tabInfo._piBridgeGeneration;
        if (
            typeof generation === 'string' &&
            /^\d+$/.test(generation) &&
            typeof seenGen === 'string' &&
            /^\d+$/.test(seenGen)
        ) {
            try {
                const gen = BigInt(generation);
                const prev = BigInt(seenGen);
                if (gen > prev) return true;
                if (gen < prev) return false;
            } catch (_e) {
                // Fall through to the run comparison.
            }
        }
        try {
            return BigInt(run) > BigInt(seen);
        } catch (_e) {
            return run !== seen;
        }
    }

    // _piBridgeHasBaseline reports whether this tab has observed bridge
    // run state before (a high-water mark exists). First sight is always
    // a silent baseline, never a catch-up bell.
    _piBridgeHasBaseline(tabInfo) {
        const seen = tabInfo._piBridgeLastRun;
        return typeof seen === 'string' && /^\d+$/.test(seen);
    }

    // _ringPiBridgeBell marks a settled run done and always raises
    // attention (marker, toast, chime, OS notification), even for the
    // active visible tab: a settlement is solid bridge signal, and
    // completion is worth announcing while watching. The idle scan
    // clears the marker for foreground tabs; the toast and chime stand.
    _ringPiBridgeBell(tabInfo) {
        tabInfo.userTaskActive = false;
        tabInfo.busyStartTime = null;
        this._setTabAttention(tabInfo, true);
        this.updateDocumentTitle();
        // Ready-at-prompt, never a success claim: the outcome may be an
        // error or explicitly unknown.
        this.triggerAttentionNotification(tabInfo, true);
    }

    // handleServerShutdown is invoked when the WS control stream receives
    // a 0x05 frame. Polls /api/version every 1s; reloads the page when the
    // server is back (different commit or after a generous timeout).
    handleServerShutdown(reason) {
        if (this._reloadArmed) return;
        this._reloadArmed = true;

        // Show a one-time toast so the user knows what's happening.
        if (this.app?.showToast) {
            this.app.showToast(`phi is ${reason}… reloading when ready.`, {
                type: 'info',
                durationMs: 8000,
            });
        }

        const beforeCommit = this.app?.versionInfo?.commit || '';
        const startedAt = Date.now();
        const maxWaitMs = 10_000;

        const poll = async () => {
            // Bail out once we've waited long enough regardless.
            if (Date.now() - startedAt > maxWaitMs) {
                window.location.reload();
                return;
            }
            try {
                const res = await fetch('/api/version', { cache: 'no-store' });
                if (res.ok) {
                    const data = await res.json();
                    // Same commit + same source = same process (still
                    // tearing down). Different commit or different
                    // build_source (e.g. release->source for a swap)
                    // means the new server is up.
                    if (data?.commit && data.commit !== beforeCommit) {
                        window.location.reload();
                        return;
                    }
                }
            } catch (_) {
                // network blip while server is bouncing; keep polling
            }
            setTimeout(poll, 1000);
        };
        setTimeout(poll, 1000);
    }

    // Reload rebuilds the current terminal's connection/state. It never
    // restarts backend processes, deletes panes or fetches the whole archive.
    refreshConsole() {
        const tab = this.getActiveTab();
        if (!tab?.term || tab.finalizing || ['pi-rpc', 'review', 'kanban'].includes(tab.coder)) return;
        this._cancelHistoryRequest(tab);
        tab._forceStateRefresh = true;
        tab.userFollowBottom = true;
        this.reconnectTab(tab);
    }

    reconnectTab(tabInfo, { auto = false } = {}) {
        if (tabInfo.coder === 'pi-rpc') return;
        if (tabInfo.reconnectInFlight) {
            if (auto) return;
            // Manual retry forces recovery from stalled in-flight attempt
            if (tabInfo.reconnectWatchdogTimer) {
                clearTimeout(tabInfo.reconnectWatchdogTimer);
                tabInfo.reconnectWatchdogTimer = null;
            }
            if (tabInfo.ws) {
                try {
                    tabInfo.ws.close();
                } catch (_e) {}
                tabInfo.ws = null;
            }
            tabInfo.reconnectInFlight = false;
        }
        tabInfo.reconnectInFlight = true;
        if (tabInfo.autoReconnectTimer) {
            clearTimeout(tabInfo.autoReconnectTimer);
            tabInfo.autoReconnectTimer = null;
        }
        if (tabInfo.reconnectWatchdogTimer) {
            clearTimeout(tabInfo.reconnectWatchdogTimer);
            tabInfo.reconnectWatchdogTimer = null;
        }
        tabInfo.autoReconnectPending = false;
        tabInfo.exitCode = null;

        const overlay =
            tabInfo.termContainer.querySelector('.reconnect-overlay');
        const msgEl = overlay?.querySelector('.reconnect-msg');
        const btnEl = overlay?.querySelector('.reconnect-btn');
        const restartBtn = overlay?.querySelector('.restart-btn');

        if (msgEl) msgEl.innerText = auto ? 'reconnecting…' : 'connecting…';
        if (btnEl) btnEl.disabled = true;
        if (restartBtn) restartBtn.disabled = true;

        if (tabInfo.ws) {
            try {
                tabInfo.ws.close();
            } catch (_e) {}
            tabInfo.ws = null;
        }

        // The server replays the whole ring buffer on every attach, so without
        // clearing first a reconnect appends a second copy of the scrollback.
        // Reset on the first replayed byte rather than up front: when the
        // replay buffer is disabled server-side no data arrives, and blanking
        // the terminal would throw away history nothing is going to restore.
        tabInfo.awaitingReplay = true;

        let opened = false;
        try {
            const newWs = new PTYWebSocket(
                tabInfo.paneId,
                (data) => {
                    if (tabInfo.ws !== newWs) return;
                    this._paneData(tabInfo, data);
                },
                (control) => {
                    if (tabInfo.ws !== newWs) return;
                    this.handleControlMessage(tabInfo, control, newWs);
                },
                () => {
                    if (tabInfo.ws !== newWs) return;
                    if (tabInfo.reconnectWatchdogTimer) {
                        clearTimeout(tabInfo.reconnectWatchdogTimer);
                        tabInfo.reconnectWatchdogTimer = null;
                    }
                    tabInfo.reconnectInFlight = false;
                    // Died before proving itself: cancel the pending success
                    // reset so this attempt still counts against the backoff.
                    clearTimeout(tabInfo.reconnectStableTimer);
                    tabInfo.reconnectStableTimer = null;
                    if (opened) {
                        tabInfo.isDead = true;
                        tabInfo.tabEl.classList.add('dead');
                        this.updateDocumentTitle();
                        this._showReconnectOverlay(tabInfo);
                        this.maybeAutoReconnect(tabInfo);
                        this.updateDisconnectBanner();
                    } else {
                        tabInfo.isDead = true;
                        if (msgEl)
                            msgEl.innerText = 'Session expired (PTY gone)';
                        if (btnEl) {
                            btnEl.disabled = false;
                            btnEl.innerText = '⟳ Retry';
                        }
                        if (restartBtn) restartBtn.disabled = false;
                        this.maybeAutoReconnect(tabInfo);
                        this.updateDisconnectBanner();
                    }
                    // Same contract as _handleTerminalDisconnect: a dead
                    // socket orphans the pending native Compact waiter.
                    this._invalidatePiBridgeCompact?.(tabInfo, true);
                    this._refreshPiBridgeModels(tabInfo);
                },
                () => {
                    if (tabInfo.ws !== newWs) return;
                    if (tabInfo.reconnectWatchdogTimer) {
                        clearTimeout(tabInfo.reconnectWatchdogTimer);
                        tabInfo.reconnectWatchdogTimer = null;
                    }
                    opened = true;
                    tabInfo._perfAttachAt = performance.now();
                    tabInfo._perfWrote = false;
                    termPerfMark('ws-open');
                    // Clearing the backoff here on open (rather than after the
                    // connection survives) meant the counter could never climb:
                    // open -> die -> retry reset it every cycle, so the
                    // exponential backoff never engaged and the attempt cap was
                    // unreachable. A flapping pane redialled forever at ~500ms.
                    clearTimeout(tabInfo.reconnectStableTimer);
                    tabInfo.reconnectStableTimer = setTimeout(() => {
                        tabInfo.reconnectAttempts = 0;
                        tabInfo.reconnectStableTimer = null;
                    }, AUTO_RECONNECT_STABLE_MS);
                    tabInfo.reconnectInFlight = false;
                    tabInfo.isDead = false;
                    // A reconnect starts quiet. Without this reset, a PTY
                    // that disconnected while busy would revive the ϕ mark
                    // before it had emitted any new output.
                    tabInfo.isBusy = false;
                    tabInfo.lastOutputAt = undefined;
                    tabInfo.busyStartTime = null;
                    tabInfo.userTaskActive = false;
                    tabInfo.userTaskStartTime = null;
                    tabInfo.tabEl.classList.remove('dead');
                    this.updateDocumentTitle();
                    if (overlay) overlay.remove();
                    this.updateDisconnectBanner();
                    setTimeout(() => {
                        try {
                            if (tabInfo === this.getActiveTab()) {
                                tabInfo.term.refresh(0, tabInfo.term.rows - 1);
                            }
                        } catch (e) {
                            console.error(
                                '[term] Fit/refresh error on reconnect:',
                                e,
                            );
                        }
                        this.activateTabViewport(tabInfo, {
                            scrollToBottom: true,
                            autoReconnect: false,
                        });
                    }, 100);
                },
                this._hotOptions(tabInfo),
            );
            this._setCurrentTabSocket(tabInfo, newWs);
            tabInfo.reconnectWatchdogTimer = setTimeout(() => {
                tabInfo.reconnectWatchdogTimer = null;
                if (tabInfo.reconnectInFlight && tabInfo.ws === newWs) {
                    console.warn(
                        '[term] Reconnect attempt timed out after 10s',
                    );
                    tabInfo.reconnectInFlight = false;
                    try {
                        newWs.close();
                    } catch (_e) {}
                    if (tabInfo.ws === newWs) tabInfo.ws = null;
                    tabInfo.isDead = true;
                    if (msgEl) msgEl.innerText = 'Connection timed out';
                    if (btnEl) {
                        btnEl.disabled = false;
                        btnEl.innerText = '⟳ Retry';
                    }
                    if (restartBtn) restartBtn.disabled = false;
                    this.updateDisconnectBanner();
                }
            }, 10_000);
        } catch (e) {
            if (tabInfo.reconnectWatchdogTimer) {
                clearTimeout(tabInfo.reconnectWatchdogTimer);
                tabInfo.reconnectWatchdogTimer = null;
            }
            tabInfo.reconnectInFlight = false;
            if (msgEl) msgEl.innerText = `failed: ${e.message}`;
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.innerText = '⟳ Retry';
            }
            if (restartBtn) restartBtn.disabled = false;
            console.error('[term] PTYWebSocket instantiation threw:', e);
        }
    }

    restartTab(tabInfo) {
        if (tabInfo.coder === 'pi-rpc') return;
        // Restart drops the old pane: release Thinking ownership while the
        // pending operation still carries this pane id.
        if (tabInfo.coder === 'pi') this._invalidatePiBridgeThinking(tabInfo);
        const overlay =
            tabInfo.termContainer.querySelector('.reconnect-overlay');
        const msgEl = overlay?.querySelector('.reconnect-msg');
        const reconnectBtn = overlay?.querySelector('.reconnect-btn');
        const restartBtn = overlay?.querySelector('.restart-btn');

        if (msgEl) msgEl.innerText = 'restarting…';
        if (reconnectBtn) reconnectBtn.disabled = true;
        if (restartBtn) restartBtn.disabled = true;

        if (tabInfo.reconnectWatchdogTimer) {
            clearTimeout(tabInfo.reconnectWatchdogTimer);
            tabInfo.reconnectWatchdogTimer = null;
        }
        if (tabInfo.autoReconnectTimer) {
            clearTimeout(tabInfo.autoReconnectTimer);
            tabInfo.autoReconnectTimer = null;
        }
        tabInfo.autoReconnectPending = false;
        tabInfo.reconnectInFlight = false;
        tabInfo.reconnectAttempts = 0;

        if (tabInfo.ws) {
            try {
                tabInfo.ws.close();
            } catch (_e) {}
            tabInfo.ws = null;
        }
        // A restart orphans the pending native Compact waiter for the
        // old pane before the new lease is provisioned.
        this._invalidatePiBridgeCompact?.(tabInfo);

        fetch('/api/terminals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                coder: tabInfo.coder,
                cwd: tabInfo.cwd,
                session_id: tabInfo.sessionId || '',
                title: tabInfo.title || '',
                workspace: tabInfo.workspace || '',
                ...(tabInfo.coder === 'opencode' ? { opencode_mini: isOpenCodeMini(tabInfo) } : {}),
            }),
        })
            .then((res) => {
                if (!res.ok)
                    throw new Error('failed to spawn restarted session');
                return res.json();
            })
            .then((data) => {
                const oldPaneId = tabInfo.paneId;

                // Update paneId and sessionId
                tabInfo.paneId = data.pane_id;
                tabInfo.sessionId = data.session_id;
                if (tabInfo.coder === 'opencode') {
                    tabInfo.opencodeMode = openCodePaneMode(data.opencode_mode);
                }
                // A restart provisions a fresh lease; drop bridge state.
                // The HTTP baseline seeds below, after the new socket
                // resets ordering.
                tabInfo.piBridge = undefined;
                this._resetPiBridgeOrdered(tabInfo);
                // A restart provisions a fresh lease: drop recall state
                // without flushing — the old pane is being reborn.
                this._resetPiRecall();
                tabInfo._piBridgeLastRun = undefined;
                tabInfo._piBridgeGeneration = undefined;
                tabInfo._piBridgeLive = undefined;
                // The old lease is gone: hide its meter and controls now,
                // before the new socket re-baselines.
                this._refreshPiBridgeModels(tabInfo);

                // Update DOM element references to synchronise new IDs
                tabInfo.tabEl.setAttribute('data-pane-id', data.pane_id);
                tabInfo.termContainer.id = `term-${data.pane_id}`;

                // Update TabManager map tracking
                this.tabs.delete(oldPaneId);
                this.tabs.set(data.pane_id, tabInfo);

                if (this.activePaneId === oldPaneId) {
                    this.activePaneId = data.pane_id;
                }

                // Reset terminal screen; the visual cue is written after the
                // hot attach bootstrap lands (an epoch change resets again,
                // which would erase a banner written now).
                tabInfo.term.reset();
                tabInfo._pendingResetBanner =
                    '\x1b[2J\x1b[H\r\n\x1b[33m[Restarted Session]\x1b[0m\r\n';

                let opened = false;
                const newWs = new PTYWebSocket(
                    tabInfo.paneId,
                    (msg) => {
                        if (tabInfo.ws !== newWs) return;
                        this._paneData(tabInfo, msg);
                    },
                    (control) => {
                        if (tabInfo.ws !== newWs) return;
                        this.handleControlMessage(tabInfo, control, newWs);
                    },
                    () => {
                        if (tabInfo.ws !== newWs) return;
                        if (opened) {
                            tabInfo.isDead = true;
                            tabInfo.tabEl.classList.add('dead');
                            this.updateDocumentTitle();
                            this._showReconnectOverlay(tabInfo);
                            this.updateDisconnectBanner();
                        } else {
                            tabInfo.isDead = true;
                            if (msgEl)
                                msgEl.innerText = 'Session expired (PTY gone)';
                            if (reconnectBtn) reconnectBtn.disabled = false;
                            if (restartBtn) restartBtn.disabled = false;
                            this.updateDisconnectBanner();
                        }
                        // A dead restart socket orphans the pending native
                        // Compact waiter, exactly like any other close.
                        this._invalidatePiBridgeCompact?.(tabInfo, true);
                        this._refreshPiBridgeModels(tabInfo);
                    },
                    () => {
                        if (tabInfo.ws !== newWs) return;
                        opened = true;
                        tabInfo._perfAttachAt = performance.now();
                        tabInfo._perfWrote = false;
                        termPerfMark('ws-open');
                        tabInfo.isDead = false;
                        tabInfo.isBusy = false;
                        tabInfo.lastOutputAt = undefined;
                        tabInfo.busyStartTime = null;
                        tabInfo.userTaskActive = false;
                        tabInfo.userTaskStartTime = null;
                        tabInfo.tabEl.classList.remove('dead');
                        this.updateDocumentTitle();
                        if (overlay) overlay.remove();
                        this.updateDisconnectBanner();

                        // Trigger terminal fit & backend resize to synchronise viewport
                        setTimeout(() => {
                            this.activateTabViewport(tabInfo, {
                                scrollToBottom: true,
                                autoReconnect: false,
                            });
                        }, 100);
                    },
                    this._hotOptions(tabInfo),
                );
                this._setCurrentTabSocket(tabInfo, newWs);
                if (data.pi_bridge != null)
                    this._seedHttpPiBridge(tabInfo, data.pi_bridge);

                // Sync with session list in sidebar
                if (this.app.sessionsManager) {
                    this.app.sessionsManager.loadSessions();
                }
            })
            .catch((err) => {
                console.error('[restart] Failed to restart tab:', err);
                if (msgEl) msgEl.innerText = 'restart failed';
                if (reconnectBtn) reconnectBtn.disabled = false;
                if (restartBtn) restartBtn.disabled = false;
            });
    }

    _isDesktop() {
        return Boolean(
            this.app?.isDesktop ||
                (typeof document !== 'undefined' &&
                    document.documentElement?.hasAttribute(
                        'data-phi-desktop',
                    )) ||
                (typeof window !== 'undefined' &&
                    (window.__phiDesktop ||
                        new URLSearchParams(window.location?.search || '').get(
                            'desktop',
                        ) === '1')),
        );
    }

    updateDisconnectBanner() {
        const banner = document.getElementById('disconnect-banner');
        if (!banner) return;

        const isDesktop = this._isDesktop();
        const autoReconnectConfig = this.app?.config?.auto_reconnect;
        const autoReconnectActive =
            isDesktop &&
            autoReconnectConfig === 'visible' &&
            (typeof document === 'undefined' ||
                document.visibilityState === 'visible');

        const deadTabs = [];
        for (const tabInfo of this.tabs.values()) {
            if (
                tabInfo.isDead &&
                (tabInfo.exitCode === undefined || tabInfo.exitCode === null) &&
                tabInfo.coder !== 'review' &&
                tabInfo.coder !== 'kanban' &&
                tabInfo.coder !== 'pi-rpc'
            ) {
                if (
                    autoReconnectActive &&
                    (tabInfo.autoReconnectPending || tabInfo.reconnectInFlight)
                ) {
                    continue;
                }
                deadTabs.push(tabInfo);
            }
        }

        const currentCount = deadTabs.length;
        if (currentCount === 0) {
            banner.classList.add('hidden');
            this._bannerDismissed = false;
            this._dismissedCount = 0;
            return;
        }

        if (this._bannerDismissed && currentCount <= this._dismissedCount) {
            banner.classList.add('hidden');
            return;
        }

        this._bannerDismissed = false;
        banner.classList.remove('hidden');
        banner.innerHTML = `
            <span>${currentCount} tab${currentCount > 1 ? 's' : ''} disconnected</span>
            <div style="display: flex; gap: 8px;">
                <button class="disconnect-banner-btn reconnect-all-banner-btn">Reconnect all</button>
                <button class="disconnect-banner-btn dismiss-banner-btn" style="background:transparent;border-color:rgba(255,255,255,0.2);">Dismiss</button>
            </div>
        `;

        banner
            .querySelector('.reconnect-all-banner-btn')
            .addEventListener('click', () => {
                this.reconnectAllDead();
            });
        banner
            .querySelector('.dismiss-banner-btn')
            .addEventListener('click', () => {
                this._bannerDismissed = true;
                this._dismissedCount = currentCount;
                banner.classList.add('hidden');
            });
    }

    reconnectAllDead() {
        let count = 0;
        for (const tabInfo of this.tabs.values()) {
            if (
                tabInfo.isDead &&
                (tabInfo.exitCode === undefined || tabInfo.exitCode === null) &&
                tabInfo.coder !== 'review' &&
                tabInfo.coder !== 'kanban' &&
                tabInfo.coder !== 'pi-rpc'
            ) {
                tabInfo.reconnectAttempts = 0;
                if (tabInfo.autoReconnectTimer) {
                    clearTimeout(tabInfo.autoReconnectTimer);
                    tabInfo.autoReconnectTimer = null;
                }
                tabInfo.autoReconnectPending = false;
                this.reconnectTab(tabInfo, { auto: false });
                count++;
            }
        }
        const activeTab = this.getActiveTab();
        if (activeTab) {
            this.activateTabViewport(activeTab, {
                scrollToBottom: true,
                autoReconnect: false,
            });
        }
        this.updateDisconnectBanner();
        return count;
    }

    reconnectAllTabsWithToast() {
        const deadCount = this.reconnectAllDead();
        const total = this.tabs.size;
        if (this.app?.sessionsManager) {
            this.app.sessionsManager.loadSessions();
        }
        if (this.app && typeof this.app.showToast === 'function') {
            if (deadCount > 0) {
                this.app.showToast(
                    'info',
                    `Reconnected ${deadCount} disconnected tab${deadCount > 1 ? 's' : ''}`,
                );
            } else {
                this.app.showToast(
                    'info',
                    `Refreshed ${total} tab${total === 1 ? '' : 's'}`,
                );
            }
        }
    }

    // Revive the active tab after a wake-style signal (visibility return,
    // network restore, bfcache restore). Config- and visibility-gated like
    // the passive loop ('online' fires in hidden windows too — without the
    // visibility check, a network restore would dial from every background
    // window), but resets the attempt budget: a wake is a fresh start, not a
    // continuation of an exhausted backoff run.
    _reviveActiveTabIfDead() {
        const autoReconnect = this.app?.config?.auto_reconnect;
        if (autoReconnect !== 'visible') return;
        if (
            typeof document !== 'undefined' &&
            document.visibilityState !== 'visible'
        )
            return;

        if (this._isDesktop()) {
            let revived = 0;
            for (const tabInfo of this.tabs.values()) {
                if (
                    tabInfo.isDead &&
                    !tabInfo.reconnectInFlight &&
                    (tabInfo.exitCode === undefined ||
                        tabInfo.exitCode === null) &&
                    tabInfo.coder !== 'review' &&
                    tabInfo.coder !== 'kanban' &&
                    tabInfo.coder !== 'pi-rpc'
                ) {
                    tabInfo.reconnectAttempts = 0;
                    if (tabInfo.autoReconnectTimer) {
                        clearTimeout(tabInfo.autoReconnectTimer);
                        tabInfo.autoReconnectTimer = null;
                    }
                    tabInfo.autoReconnectPending = false;
                    this.reconnectTab(tabInfo, { auto: true });
                    revived++;
                }
            }
            if (revived > 0) {
                const activeTab = this.getActiveTab();
                if (activeTab) {
                    this.activateTabViewport(activeTab, {
                        scrollToBottom: true,
                        autoReconnect: false,
                    });
                }
            }
            this.updateDisconnectBanner();
            return;
        }

        const tabInfo = this.getActiveTab();
        if (!tabInfo?.isDead || tabInfo.reconnectInFlight) return;
        if (
            tabInfo.coder === 'review' ||
            tabInfo.coder === 'kanban' ||
            tabInfo.coder === 'pi-rpc'
        )
            return;
        if (tabInfo.exitCode !== undefined && tabInfo.exitCode !== null) return;
        tabInfo.reconnectAttempts = 0;
        if (tabInfo.autoReconnectTimer) {
            clearTimeout(tabInfo.autoReconnectTimer);
            tabInfo.autoReconnectTimer = null;
        }
        tabInfo.autoReconnectPending = false;
        this.reconnectTab(tabInfo, { auto: true });
    }

    maybeAutoReconnect(tabInfo) {
        if (tabInfo.coder === 'pi-rpc') return false;
        const autoReconnect = this.app?.config?.auto_reconnect;
        if (autoReconnect !== 'visible') return false;

        if (
            typeof document !== 'undefined' &&
            document.visibilityState !== 'visible'
        )
            return false;
        const isDesktop = this._isDesktop();
        if (!isDesktop && tabInfo.paneId !== this.activePaneId) return false;
        if (tabInfo.exitCode !== undefined && tabInfo.exitCode !== null)
            return false;

        if (tabInfo.autoReconnectTimer) {
            clearTimeout(tabInfo.autoReconnectTimer);
            tabInfo.autoReconnectTimer = null;
        }

        if (!tabInfo.reconnectAttempts) tabInfo.reconnectAttempts = 0;
        if (tabInfo.reconnectAttempts >= AUTO_RECONNECT_MAX_ATTEMPTS) {
            tabInfo.reconnectAttempts = 0;
            tabInfo.autoReconnectPending = false;
            const overlay =
                tabInfo.termContainer?.querySelector('.reconnect-overlay');
            const msgEl = overlay?.querySelector('.reconnect-msg');
            const btnEl = overlay?.querySelector('.reconnect-btn');
            const restartBtn = overlay?.querySelector('.restart-btn');
            if (msgEl) msgEl.innerText = 'Auto-reconnect failed (disconnected)';
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.innerText = '⟳ Retry';
            }
            if (restartBtn) restartBtn.disabled = false;
            this.updateDisconnectBanner();
            return false;
        }

        tabInfo.reconnectAttempts++;
        tabInfo.autoReconnectPending = true;
        const backoff = Math.min(
            AUTO_RECONNECT_MAX_DELAY_MS,
            2 ** (tabInfo.reconnectAttempts - 1) * 1000,
        );
        const delay = AUTO_RECONNECT_GRACE_MS + Math.random() * backoff;

        console.log(
            `[term] Auto-reconnecting pane ${tabInfo.paneId} (attempt ${tabInfo.reconnectAttempts}) in ${delay}ms...`,
        );

        const overlay =
            tabInfo.termContainer.querySelector('.reconnect-overlay');
        const msgEl = overlay?.querySelector('.reconnect-msg');
        if (msgEl)
            msgEl.innerText = `auto-reconnecting (attempt ${tabInfo.reconnectAttempts}/${AUTO_RECONNECT_MAX_ATTEMPTS})...`;

        tabInfo.autoReconnectTimer = setTimeout(() => {
            tabInfo.autoReconnectTimer = null;
            tabInfo.autoReconnectPending = false;
            if (
                tabInfo.isDead &&
                (isDesktop || tabInfo.paneId === this.activePaneId) &&
                (tabInfo.exitCode === undefined || tabInfo.exitCode === null)
            ) {
                this.reconnectTab(tabInfo, { auto: true });
            }
        }, delay);

        return true;
    }

    toggleFindBar(tabInfo) {
        const existing = tabInfo.termContainer.querySelector('.find-bar');
        if (existing) {
            existing.remove();
            if (tabInfo.searchAddon) {
                tabInfo.searchAddon.clearDecorations();
            }
            tabInfo.term.focus();
            return;
        }

        const bar = document.createElement('div');
        bar.className = 'find-bar';
        bar.innerHTML = `
            <input type="text" class="find-input" placeholder="Find in terminal..." />
            <button class="find-btn find-prev">▲</button>
            <button class="find-btn find-next">▼</button>
            <button class="find-btn find-close">✕</button>
        `;

        const input = bar.querySelector('.find-input');
        const prevBtn = bar.querySelector('.find-prev');
        const nextBtn = bar.querySelector('.find-next');
        const closeBtn = bar.querySelector('.find-close');

        const doSearch = (direction) => {
            const val = input.value;
            if (!val) {
                if (tabInfo.searchAddon) tabInfo.searchAddon.clearDecorations();
                return;
            }
            if (tabInfo.searchAddon) {
                if (direction === 'prev') {
                    tabInfo.searchAddon.findPrevious(val, {
                        decorations: {
                            matchBackground: 'rgba(255,255,0,0.3)',
                            activeMatchBackground: 'rgba(255,165,0,0.5)',
                        },
                    });
                } else {
                    tabInfo.searchAddon.findNext(val, {
                        decorations: {
                            matchBackground: 'rgba(255,255,0,0.3)',
                            activeMatchBackground: 'rgba(255,165,0,0.5)',
                        },
                    });
                }
            }
        };

        input.addEventListener('input', () => {
            doSearch('next');
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                doSearch(e.shiftKey ? 'prev' : 'next');
            } else if (e.key === 'Escape') {
                e.preventDefault();
                bar.remove();
                if (tabInfo.searchAddon) tabInfo.searchAddon.clearDecorations();
                tabInfo.term.focus();
            }
        });

        prevBtn.addEventListener('click', () => doSearch('prev'));
        nextBtn.addEventListener('click', () => doSearch('next'));
        closeBtn.addEventListener('click', () => {
            bar.remove();
            if (tabInfo.searchAddon) tabInfo.searchAddon.clearDecorations();
            tabInfo.term.focus();
        });

        tabInfo.termContainer.appendChild(bar);
        input.focus({ preventScroll: true });
    }

    /**
     * Toggles visual tab shortcut badges (1..8, and 9 for last tab)
     * replacing the worktree hieroglyph when Alt/Option is held.
     */
    updateTabShortcutHints(show) {
        if (typeof document === 'undefined') return;
        if (!show) {
            document.body?.classList.remove('show-tab-shortcuts');
            return;
        }
        const paneIds = Array.from(this.tabs.keys());
        if (paneIds.length === 0) {
            document.body?.classList.remove('show-tab-shortcuts');
            return;
        }
        const total = paneIds.length;
        for (let i = 0; i < total; i++) {
            const tabInfo = this.tabs.get(paneIds[i]);
            if (!tabInfo?.tabEl) continue;
            const badge = tabInfo.tabEl.querySelector('.tab-shortcut-badge');
            let hint = '';
            if (i < 8) {
                hint = String(i + 1);
            } else if (i === total - 1) {
                hint = '9';
            }
            if (badge) {
                badge.textContent = hint;
            }
            if (hint) {
                tabInfo.tabEl.classList.add('has-shortcut');
            } else {
                tabInfo.tabEl.classList.remove('has-shortcut');
            }
        }
        document.body?.classList.add('show-tab-shortcuts');
    }

    handleGlobalTabShortcuts(e) {
        if (this.handleInputToggleShortcut?.(e)) {
            return;
        }

        // Shift+F5 or Ctrl/Cmd+Shift+R: Reconnect / refresh all tabs in current workspace (Idea A)
        if (
            (e.shiftKey &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.altKey &&
                e.key === 'F5') ||
            ((e.ctrlKey || e.metaKey) &&
                e.shiftKey &&
                !e.altKey &&
                (e.key === 'r' || e.key === 'R'))
        ) {
            e.preventDefault();
            this.reconnectAllTabsWithToast();
            return;
        }

        if (
            e.ctrlKey &&
            e.shiftKey &&
            !e.altKey &&
            !e.metaKey &&
            e.key.toLowerCase() === 'f'
        ) {
            const activeTab = this.getActiveTab();
            if (activeTab?.term) {
                e.preventDefault();
                this.toggleFindBar(activeTab);
            }
            return;
        }

        const isMac = isMacPlatform();
        const isTabSwitchModifier =
            !e.ctrlKey && !e.shiftKey && (e.altKey || (isMac && e.metaKey));
        const digit = isTabSwitchModifier ? tabShortcutDigit(e) : null;

        if (digit !== null) {
            const num = digit;
            const paneIds = Array.from(this.tabs.keys());
            if (paneIds.length === 0) return;

            e.preventDefault();

            let targetPaneId;
            if (num === 9) {
                // Alt+9 / Cmd+9 switches to the last tab
                targetPaneId = paneIds[paneIds.length - 1];
            } else {
                // Alt+1..8 / Cmd+1..8 switch to corresponding index
                const idx = num - 1;
                if (idx < paneIds.length) {
                    targetPaneId = paneIds[idx];
                }
            }

            if (targetPaneId !== undefined) {
                this.switchTab(targetPaneId, { userInitiated: true });
            }
            return;
        }

        if (
            e.ctrlKey &&
            e.shiftKey &&
            !e.altKey &&
            !e.metaKey &&
            e.key === 'Enter'
        ) {
            const activeTab = this.getActiveTab();
            if (activeTab && activeTab.coder !== 'pi-rpc') {
                e.preventDefault();
                this.sendInput(activeTab, '\x1b[A');
                setTimeout(() => {
                    this.sendInput(activeTab, '\r');
                }, 30);
            }
        }

        // Ctrl+P: capture it so the browser's print dialog never hijacks the key,
        // and forward it (\x10) to the active terminal — opencode and other TUIs
        // use Ctrl+P. Runs at document bubble phase, so if an earlier handler
        // already dealt with it (e.g. the empty staged-input box calls
        // preventDefault and sends \x10 itself, or xterm consumed it while the
        // terminal was focused) we bail via defaultPrevented to avoid double-send.
        if (
            e.ctrlKey &&
            !e.altKey &&
            !e.metaKey &&
            !e.shiftKey &&
            e.key.toLowerCase() === 'p'
        ) {
            if (e.defaultPrevented) return;
            const activeTab = this.getActiveTab();
            if (
                activeTab &&
                activeTab.coder !== 'review' &&
                activeTab.coder !== 'kanban' &&
                activeTab.coder !== 'pi-rpc'
            ) {
                e.preventDefault();
                this.sendInput(activeTab, '\x10');
                this._spamScrollToBottom(activeTab);
            }
            return;
        }
    }

    adjustInputHeight() {
        if (!this.inputTextArea) return;
        this.inputTextArea.style.height = 'auto';
        let newHeight = this.inputTextArea.scrollHeight;
        // If empty, prevent the placeholder wrap from making the textarea fat
        if (this.inputTextArea.value.trim() === '') {
            newHeight = isCompactViewport() ? 36 : 40;
            if (isCompactViewport()) {
                this.inputTextArea.placeholder = 'Type a prompt...';
            }
        }
        this.inputTextArea.style.height = `${newHeight}px`;
    }

    // A wheel, touch, or native scrollbar-thumb gesture is an explicit user
    // choice. Cancel only the currently pending restore; `_spamScroll` itself
    // remains the established 10ms / 300ms mechanism for non-interrupted
    // resize, reflow, output, and explicit bottom-follow paths. Also flips
    // userFollowBottom to false so PTY output arriving in this state
    // doesn't snap the viewport back to bottom.
    _cancelScrollFollowForUserScroll(tabInfo) {
        if (!tabInfo) return;
        clearInterval(tabInfo.spamInterval);
        clearTimeout(tabInfo.stopSpamTimeout);
        tabInfo.spamInterval = null;
        tabInfo.stopSpamTimeout = null;
        tabInfo.isSpammingBottom = undefined;
        tabInfo.spamScrollY = undefined;
        tabInfo.userFollowBottom = false;
    }

    // xterm derives its scrollable position from buffer-level scroll
    // events (`Viewport._sync`). A bootstrap screen checkpoint resizes the
    // terminal while the buffer is still empty, which syncs that position
    // to 0; the replay that follows fills the buffer without a programmatic
    // scroll, so the internal position stays stale at the top. From there
    // every viewport-path scroll is clamped — including wheel, PageUp, and
    // `scrollToBottom()` itself, which short-circuits (disp 0) before it can
    // fire the scroll event that would re-derive the position — leaving the
    // user unable to reach scrollback after a reload. A synchronous
    // top→bottom round trip re-derives the position from the buffer; nothing
    // paints between the two calls, so it is visually inert.
    _resyncViewportScroll(tabInfo) {
        const term = tabInfo?.term;
        const buffer = term?.buffer?.active;
        if (!term || !buffer || tabInfo._historyBrowsing) return;
        // Alternate-screen apps own the visible screen; normal scrollback is
        // not what their viewport is showing.
        if (buffer.baseY <= 0 || buffer.viewportY < buffer.baseY) return;
        try {
            term.scrollToTop();
            term.scrollToBottom();
        } catch (_e) {
            /* xterm not open yet; a later fit resyncs */
        }
    }

    _spamScroll(tabInfo, isAtBottom, scrollY = null) {
        if (!tabInfo || tabInfo.isDead) return;

        this._resyncViewportScroll(tabInfo);

        clearInterval(tabInfo.spamInterval);
        clearTimeout(tabInfo.stopSpamTimeout);

        tabInfo.isSpammingBottom = isAtBottom;
        tabInfo.spamScrollY = scrollY;

        tabInfo.spamInterval = setInterval(() => {
            if (isAtBottom) {
                if (tabInfo.userFollowBottom === false) {
                    this._cancelScrollFollowForUserScroll(tabInfo);
                    return;
                }
                tabInfo.term.scrollToBottom();
            } else if (scrollY !== null) {
                if (tabInfo.userFollowBottom === false) {
                    this._cancelScrollFollowForUserScroll(tabInfo);
                    return;
                }
                tabInfo.term.scrollToLine(scrollY);
            }
        }, 10);

        tabInfo.stopSpamTimeout = setTimeout(() => {
            clearInterval(tabInfo.spamInterval);
            tabInfo.spamInterval = null;
            tabInfo.stopSpamTimeout = null;
            tabInfo.isSpammingBottom = undefined;
            tabInfo.spamScrollY = undefined;
            if (isAtBottom && tabInfo.userFollowBottom !== false) {
                tabInfo.term.scrollToBottom();
            } else if (scrollY !== null && tabInfo.userFollowBottom !== false) {
                tabInfo.term.scrollToLine(scrollY);
            }
        }, 300);
    }

    _spamScrollToBottom(tabInfo) {
        this._spamScroll(tabInfo, true);
    }

    copyTextRobustly(text, silent = false) {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard
                .writeText(text)
                .then(() => {
                    if (!silent) {
                        this.app.showToast('Copied to clipboard', {
                            type: 'info',
                            title: 'Clipboard',
                        });
                    }
                })
                .catch(() => this.fallbackCopy(text, silent));
        } else {
            this.fallbackCopy(text, silent);
        }
    }

    fallbackCopy(text, silent = false) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let success = false;
        try {
            success = document.execCommand('copy');
            if (success && !silent) {
                this.app.showToast('Copied to clipboard', {
                    type: 'info',
                    title: 'Clipboard',
                });
            }
        } catch (e) {
            console.error('Fallback copy failed', e);
        }
        document.body.removeChild(ta);
        if (!success && !silent) {
            this.app.showToast('Failed to copy. Please copy manually.', {
                type: 'error',
                title: 'Clipboard',
            });
        }
    }

    // Synchronous execCommand('copy') via a hidden textarea. Returns whether it
    // succeeded. Works in insecure contexts (plain-HTTP LAN access) where the
    // async Clipboard API is unavailable, as long as it runs within a user
    // gesture. Does not show any toast.
    _execCommandCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus({ preventScroll: true });
        ta.select();
        let ok = false;
        try {
            ok = document.execCommand('copy');
        } catch (_e) {
            ok = false;
        }
        document.body.removeChild(ta);
        return ok;
    }

    _installTerminalLinkProvider(term) {
        return installTerminalLinkProvider(term, (url) => {
            openExternalLink(url);
        });
    }

    // Copy text the agent emitted via OSC 52. phi is commonly served over plain
    // HTTP on a LAN address, where navigator.clipboard is undefined and calling
    // writeText throws synchronously — the previous inline handler let that
    // exception fall into the OSC decode catch, so opencode reported "copied"
    // while nothing reached the clipboard. Prefer the async Clipboard API when
    // it truly exists in a secure context, otherwise fall back to execCommand,
    // and if every automated attempt fails, surface a toast with a manual copy
    // button that runs inside the click's user-gesture. Returns a promise.
    _agentClipboardCopy(text) {
        const okToast = () =>
            this.app.showToast(
                `Agent copied ${text.length} characters to clipboard`,
                { type: 'info', title: 'Clipboard Sync' },
            );
        const manualToast = () =>
            this.app.showToast(`Agent copied ${text.length} characters`, {
                type: 'info',
                title: 'Clipboard Sync',
                duration: 15000,
                action: {
                    text: 'Copy to Clipboard',
                    callback: () => {
                        if (this._execCommandCopy(text)) {
                            this.app.showToast('Copied to clipboard!', {
                                type: 'info',
                                title: 'Clipboard Sync',
                            });
                        } else {
                            this.app.showToast(
                                'Failed to copy. Please copy manually.',
                                { type: 'error', title: 'Clipboard Sync' },
                            );
                        }
                    },
                },
            });

        if (
            navigator.clipboard &&
            window.isSecureContext &&
            navigator.clipboard.writeText
        ) {
            return navigator.clipboard
                .writeText(text)
                .then(okToast)
                .catch(() => {
                    if (this._execCommandCopy(text)) okToast();
                    else manualToast();
                });
        }
        // Insecure context (e.g. http://host:port over LAN): no Clipboard API.
        if (this._execCommandCopy(text)) okToast();
        else manualToast();
        return Promise.resolve();
    }

    startResize() {
        const activeTab = this.getActiveTab();
        if (!activeTab || activeTab.isDead) return;

        // Save the correct, stable scroll state before the continuous resize begins
        if (activeTab.isAtBottom === undefined) {
            const buffer = activeTab.term.buffer.active;
            activeTab.isAtBottom = buffer.viewportY >= buffer.baseY;
            activeTab.lastScrollY = buffer.viewportY;
        }
        this.isResizing = true;
    }

    endResize() {
        this.isResizing = false;
        const activeTab = this.getActiveTab();
        if (activeTab) {
            activeTab.isAtBottom = undefined;
            activeTab.lastScrollY = undefined;
            this._queuePanelFit?.(activeTab, { forceResize: true });
        }
    }

    // classifyGeometryChange distinguishes software-keyboard animation
    // (height moves at identical width) from real layout changes
    // (rotation, drawer, window drag). Pure over its inputs except for
    // updating the last-seen dims; unit-tested in
    // test-js/keyboardFit.test.js.
    classifyGeometryChange(w, h) {
        const widthChanged = w !== this._lastWindowW;
        const heightChanged = h !== this._lastWindowH;
        this._lastWindowW = w;
        this._lastWindowH = h;
        return !widthChanged && heightChanged ? 'keyboard' : 'layout';
    }

    // handleWindowResize is the single choke point for window geometry.
    // Extracted as a method (not an inline closure) so the NEVER-keyboard
    // contract is unit-testable in test-js/keyboardFit.test.js.
    handleWindowResize() {
        const kind = this.classifyGeometryChange(
            window.innerWidth,
            window.innerHeight,
        );
        if (kind === 'keyboard' && isCoarseViewport()) return;
        this.startResize();
        clearTimeout(this._windowResizeTimeout);
        this._windowResizeTimeout = setTimeout(() => {
            this.fitActiveTerminal();
            this.endResize();
        }, 100);
    }

    fitActiveTerminal({ forceResize = false } = {}) {
        const activeTab = this.getActiveTab();
        if (!activeTab || activeTab.isDead) return;
        const visible = this._terminalPanelVisible(activeTab);
        if (activeTab._bootstrapGate || !visible) {
            activeTab._pendingPanelFit = true;
            activeTab._pendingForceResize = Boolean(activeTab._pendingForceResize || forceResize || !visible);
            return;
        }

        try {
            if (forceResize) activeTab.term._core?._charSizeService?.measure?.();
            const oldCols = activeTab.term.cols, oldRows = activeTab.term.rows;
            // One DOM measurement per fit: the proposal feeds both font
            // resolution and the same-geometry skip check below.
            const proposed = activeTab.fitAddon?.proposeDimensions?.();
            const size = this.resolveTerminalFontSize(
                activeTab,
                this.app?.terminalFontSize,
                proposed,
            );
            if (activeTab.term.options.fontSize !== size) {
                activeTab.term.options.fontSize = size;
            } else if (!this.isResizing) {
                // Same-geometry fits change nothing on screen (the addon
                // itself early-returns before resize), but falling through
                // would still run scroll capture, _spamScroll timers, and
                // a backend SIGWINCH round-trip. Tab switches and settle
                // events with unchanged geometry skip all of it.
                // Gated on !isResizing: mid-resize fits own the cached
                // isAtBottom/lastScrollY lifecycle (written when undefined,
                // cleared after a non-resize fit). Skipping mid-resize
                // would strand stale coordinates for a later genuine fit
                // to restore as a viewport jump.
                if (
                    proposed &&
                    proposed.cols === activeTab.term.cols &&
                    proposed.rows === activeTab.term.rows
                ) {
                    // Gate tooling continuity: skipped fits cost ~one
                    // layout read, so they emit their own mark instead of
                    // silently absenting the `fit` measure.
                    termPerfMark('fit-skipped');
                    // The fall-through path clears these below; skipping
                    // must clear them too, or coordinates cached during an
                    // earlier resize survive into a later genuine fit and
                    // restore a stale viewport position (visible jump).
                    activeTab.isAtBottom = undefined;
                    activeTab.lastScrollY = undefined;
                    if (activeTab._historyLiveState) {
                        activeTab._historyLiveState.cols = activeTab.term.cols;
                        activeTab._historyLiveState.rows = activeTab.term.rows;
                    }
                    if (forceResize || activeTab._sizedWs !== activeTab.ws) {
                        // First fit on a fresh socket: the client reflow is
                        // correctly skipped, but the backend PTY still has
                        // its spawn size (not the grid the user sees).
                        // Tell it once; later skips stay silent. The mark
                        // records only a resize that actually went out — a
                        // send swallowed while CONNECTING must not suppress
                        // the retry after open.
                        this._refreshTerminalScreen?.(activeTab);
                        if (this.sendResizeToBackend(activeTab)) {
                            activeTab._sizedWs = activeTab.ws;
                        }
                    }
                    return;
                }
            }

            // Every fit reflows the live buffer; timing it
            // is how the tablet gate distinguishes "fit is slow" from
            // "network delivery is slow".
            const _fitT0 = performance.now();

            // Capture scroll state PRE-FIT
            const buffer = activeTab.term.buffer.active;
            let isAtBottom;
            let scrollY;

            // If we are resizing continuously, cache these stable coordinates on the tab
            if (this.isResizing) {
                isAtBottom =
                    activeTab.isAtBottom === undefined
                        ? buffer.viewportY >= buffer.baseY
                        : activeTab.isAtBottom;
                scrollY =
                    activeTab.lastScrollY === undefined
                        ? buffer.viewportY
                        : activeTab.lastScrollY;
                activeTab.isAtBottom = isAtBottom;
                activeTab.lastScrollY = scrollY;
            } else if (
                activeTab.spamInterval &&
                activeTab.isSpammingBottom !== undefined
            ) {
                // If a spam scroll is already trying to force the scroll position, respect its intended target
                // instead of capturing a mid-flight coordinate.
                isAtBottom = activeTab.isSpammingBottom;
                scrollY = activeTab.spamScrollY;
            } else {
                isAtBottom = buffer.viewportY >= buffer.baseY;
                scrollY = buffer.viewportY;
            }

            activeTab.fitAddon.fit();
            const fitMs = termPerfMeasureSince('fit', _fitT0);
            termPerfLogSlowFit(
                fitMs,
                activeTab.term.cols,
                activeTab.term.rows,
                buffer.length,
            );

            // Restore scroll state POST-FIT using the unified helper to synchronise viewport
            this._spamScroll(activeTab, isAtBottom, scrollY);

            // Clear temporary saved scroll state only if NOT in the middle of a continuous resize
            if (!this.isResizing) {
                activeTab.isAtBottom = undefined;
                activeTab.lastScrollY = undefined;
            }

            this._refreshTerminalScreen?.(activeTab);
            if (activeTab._historyLiveState) {
                activeTab._historyLiveState.cols = activeTab.term.cols;
                activeTab._historyLiveState.rows = activeTab.term.rows;
            }
            // Coalesce sub-cell drag movements; final settle/activation forces
            // a redraw even at the same grid without SIGWINCH on every pixel.
            if ((forceResize || activeTab._sizedWs !== activeTab.ws || oldCols !== activeTab.term.cols || oldRows !== activeTab.term.rows) && this.sendResizeToBackend(activeTab)) {
                activeTab._sizedWs = activeTab.ws;
            }
        } catch (e) {
            console.error('[term] Fit error:', e);
        }
    }

    activateTabViewport(
        tabInfo,
        { scrollToBottom = true, autoReconnect = true, force = false } = {},
    ) {
        if (!tabInfo) return;

        // Fit after layout, not after a guessed 50ms settling interval.
        // Coalescing retains the force bit through bootstrap/history gates.
        this._queuePanelFit(tabInfo, { forceResize: true });

        if (scrollToBottom && tabInfo.term && !tabInfo.isDead) {
            this._spamScrollToBottom(tabInfo);
        }

        // Mobile external-keyboard focus: when a tab becomes active on a
        // phone with an external keyboard attached, the user's typing
        // intent is unambiguous — they want to type into the staged
        // input bar. Without this, focus stays on the previous tab's
        // xterm and the user has to tap the input bar before their hw
        // keyboard routes anywhere. Desktop keeps the original path
        // (focus on xterm) so terminal-internal tools still capture
        // keys normally. Direct mode still wins — if the tab is in
        // direct mode, the xterm is where the user is typing.
        if (
            prefersInputBarFocus() &&
            !tabInfo.directMode &&
            !tabInfo.isDead &&
            this.inputTextArea &&
            !this.inputBarContainer?.classList.contains('hidden') &&
            !document.querySelector(
                '.modal-overlay:not(.hidden), .md-modal-overlay:not(.hidden)',
            )
        ) {
            setTimeout(
                () => this.inputTextArea.focus({ preventScroll: true }),
                80,
            );
        }

        // force=true bypasses the passive auto_reconnect gate for explicit user actions.
        const configAutoReconnect = this.app.config?.auto_reconnect;
        if (
            autoReconnect &&
            (force || configAutoReconnect === 'visible') &&
            tabInfo.isDead &&
            tabInfo.coder !== 'review' &&
            tabInfo.coder !== 'kanban' &&
            tabInfo.coder !== 'pi-rpc' &&
            !tabInfo.reconnectInFlight
        ) {
            if (tabInfo.exitCode === undefined || tabInfo.exitCode === null) {
                tabInfo.reconnectAttempts = 0;
                if (tabInfo.autoReconnectTimer) {
                    clearTimeout(tabInfo.autoReconnectTimer);
                    tabInfo.autoReconnectTimer = null;
                }
                tabInfo.autoReconnectPending = false;
                this.reconnectTab(tabInfo, { auto: true });
            }
        }
    }

    // Reports whether the resize went out so first-fit sync can retry
    // an unsent sizing later. Fakes returning undefined count as sent
    // (the historical assumption); only an explicit false means dropped.
    sendResizeToBackend(tab) {
        if (!tab || tab.isDead || this._terminalPanelVisible?.(tab) === false) return false;
        const term = tab.term;
        if (term?.cols && term.rows && tab.ws) {
            return tab.ws.sendResize(term.cols, term.rows) !== false;
        }
        return false;
    }

    _toggleDropup(dropupId, triggerBtn, renderFn) {
        const dropup = document.getElementById(dropupId);
        if (!dropup) return;
        const wasHidden = dropup.classList.contains('hidden');
        document.querySelectorAll('.model-presets-dropup').forEach((d) => {
            d.classList.add('hidden');
        });
        if (wasHidden) {
            const btnRect = triggerBtn.getBoundingClientRect();
            const container = document.querySelector('.terminal-content');
            const containerRect = container?.getBoundingClientRect?.() || {
                left: 0,
                width: window.innerWidth,
            };
            let left = btnRect.left - containerRect.left;
            const dropupWidth = isCompactViewport()
                ? Math.min(280, window.innerWidth - 24)
                : dropupId === 'pi-rpc-model-dropup'
                  ? 420
                  : dropupId === 'pi-rpc-thinking-dropup'
                    ? 280
                    : dropupId === 'keys-presets-dropup'
                      ? 300
                      : 320;
            left = Math.max(
                12,
                Math.min(left, containerRect.width - dropupWidth - 12),
            );
            dropup.style.left = `${left}px`;
            dropup.classList.remove('hidden');
            renderFn();
        }
    }

    renderPresets(coderId) {
        const activeTab = this.getActiveTab();
        if (activeTab?.coder === 'pi-rpc') {
            this._renderPiRpcPresets();
            return;
        }
        if (!this.presetsContainer) return;
        if (activeTab?.coder === 'pi') {
            if (!this._piBridgeModelsEligible(activeTab)) {
                ++this._piRpcMenuRequest;
                this._piRpcModels = null;
                this._piBridgeModelsTruncated = false;
                this._piBridgeModelsUnavailable = false;
                this._dropPiRpcModelInflight(activeTab.paneId);
                const modelDropup = document.getElementById('pi-rpc-model-dropup');
                modelDropup?.classList.add('hidden');
                modelDropup?.replaceChildren();
            }
            // The retained skill list belongs to the runtime that
            // produced it. A lost peer, a swapped socket, or a moved
            // generation drops the list and closes the picker. A
            // started invocation keeps its ownership instead: the
            // dispatch may still have landed, so its bounded reply
            // settles the outcome.
            const skillsContext = this._piBridgeSkillsContext;
            if (
                !this._piBridgeSkillsEligible(activeTab) ||
                (skillsContext?.paneId === activeTab.paneId &&
                    this._piBridgeSkillsContextStale(skillsContext))
            )
                this._invalidatePiBridgeSkillsList();
            if (!this._piBridgeThinkingEligible(activeTab))
                this._invalidatePiBridgeThinking(activeTab);
        }
        this.presetsContainer.innerHTML = '';

        const defaultPresetInfo = this.app.codersPresetRegistry[coderId];
        const miniPresets = getCoder(coderId)?.opencode_mini_presets;
        const coderPresetInfo = isOpenCodeMini(activeTab) && miniPresets?.length
            ? { ...defaultPresetInfo, presets: miniPresets }
            : defaultPresetInfo;
        const hasCoderPresets =
            coderPresetInfo?.presets && coderPresetInfo.presets.length > 0;

        // If direct mode, do not render presets
        if (activeTab?.directMode) {
            this.presetsContainer.classList.add('hidden');
            return;
        }

        this.presetsContainer.classList.remove('hidden');

        const isMobile = isCompactViewport();

        // 1. Render Static Coder Presets / Slash Menu
        if (hasCoderPresets) {
            if (isMobile) {
                // Separate slash commands from utility shortcuts
                const slashPresets = coderPresetInfo.presets.filter((p) =>
                    p.value.startsWith('/'),
                );
                const utilityPresets = coderPresetInfo.presets.filter(
                    (p) => !p.value.startsWith('/'),
                );

                // Render single Slash trigger button if slash commands exist
                if (slashPresets.length > 0) {
                    const slashBtn = document.createElement('button');
                    slashBtn.className = 'preset-btn slash-trigger-btn';
                    slashBtn.innerText = '/ ▾';
                    slashBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this._toggleDropup(
                            'slash-presets-dropup',
                            slashBtn,
                            () => this.renderSlashDropup(slashPresets),
                        );
                    });
                    this.presetsContainer.appendChild(slashBtn);
                }

                // Render other horizontal utility presets (like ctrl+c, esc, y)
                utilityPresets.forEach((p) => {
                    const btn = document.createElement('button');
                    btn.className = 'preset-btn';
                    btn.innerText = p.name;
                    btn.addEventListener('click', () => {
                        this.sendRawInput(p.value, { focusInputOnMobile: false });
                    });
                    this.presetsContainer.appendChild(btn);
                });
            } else {
                // Desktop: Render everything horizontally as before
                coderPresetInfo.presets.forEach((p) => {
                    const btn = document.createElement('button');
                    btn.className = 'preset-btn';
                    btn.innerText = p.name;
                    if (p.value === '/compact\r' && activeTab?.coder === 'pi') {
                        const compactState =
                            this._piBridgeCompactControlState(activeTab);
                        btn.disabled = compactState.disabled;
                        if (compactState.title)
                            btn.title = compactState.title;
                    }
                    btn.addEventListener('click', () => {
                        const activeTab = this.getActiveTab();
                        if (
                            activeTab &&
                            (activeTab.coder === 'opencode' ||
                                activeTab.coder === 'pi' ||
                                activeTab.coder === 'codex') &&
                            p.value.startsWith('/') &&
                            p.value.endsWith('\r')
                        ) {
                            const cmd = p.value.slice(0, -1);
                            // OpenCode delays Enter after the paste; Pi accepts
                            // the atomic paste+Enter form.
                            this.sendSlashCommand(activeTab, cmd);
                        } else {
                            this.sendRawInput(p.value);
                        }
                    });
                    this.presetsContainer.appendChild(btn);
                });
            }
        }

        // 2. Render Divider if static presets exist
        if (hasCoderPresets) {
            const divider = document.createElement('div');
            divider.className = 'presets-divider';
            this.presetsContainer.appendChild(divider);
        }

        // 2b. Pi-specific shortcut chip: lives in the presets row alongside
        // /quit /resume /model /compact, with the same flat preset-btn
        // shape (no kbd-key caps / glow, no extra id, no title, label
        // matches the existing binding convention — lowercase, no
        // separator, no action-verb suffix). Visible only when the
        // active tab is a pi session. Clicking sends the staged input
        // — same as Send ↵. The keyboard binding itself is global
        // (document-level keydown listener below) and works whether
        // the chip is rendered.
        if (coderId === 'pi') {
            const chip = document.createElement('button');
            chip.className = 'preset-btn';
            chip.innerText = 'ctrl+shift+x';
            chip.addEventListener('click', () => {
                this.sendStagedInput();
            });
            this.presetsContainer.appendChild(chip);
        }

        // 3. Render QuickCmds trigger button
        const quickCmdsTriggerBtn = document.createElement('button');
        quickCmdsTriggerBtn.className = 'preset-btn model-trigger-btn';
        quickCmdsTriggerBtn.innerText = 'Cmds ▾';
        quickCmdsTriggerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleDropup(
                'quick-commands-dropup',
                quickCmdsTriggerBtn,
                () => this.renderQuickCmdsDropup(),
            );
        });
        this.presetsContainer.appendChild(quickCmdsTriggerBtn);

        // Built-in shells and restored unknown tabs keep the original
        // Models control. New custom backends without a recipe remain
        // disabled rather than guessing a command they might not support.
        const modelsTriggerBtn = document.createElement('button');
        modelsTriggerBtn.className = 'preset-btn model-trigger-btn';
        modelsTriggerBtn.innerText = '🤖 Models ▾';

        const modelCoder = activeTab?.coder;
        const isCustomModelCoder =
            modelCoder &&
            getCoder(modelCoder) &&
            !['opencode', 'claude', 'pi', 'agy', 'bash', 'pwsh'].includes(
                modelCoder,
            );
        if (modelCoder === 'pi' && this._piBridgeModelsEligible(activeTab)) {
            // Bridge-live Pi tabs share the Pi RPC model picker.
            // Anything else falls through to the legacy static list.
            modelsTriggerBtn.classList.add('pi-rpc-model-trigger');
            modelsTriggerBtn.title = activeTab.piBridge?.model || '—';
            modelsTriggerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleDropup(
                    'pi-rpc-model-dropup',
                    modelsTriggerBtn,
                    () => this._renderPiRpcModelsDropup(),
                );
            });
        } else if (modelCoder === 'codex') {
            // /model has no inline model argument. Let Codex's live,
            // account-specific picker choose the model and reasoning effort.
            modelsTriggerBtn.innerText = '🤖 Models';
            modelsTriggerBtn.title = 'Choose model and reasoning effort in Codex';
            modelsTriggerBtn.addEventListener('click', () => {
                this.sendSlashCommand(activeTab, '/model');
            });
        } else if (
            modelCoder === 'agy' ||
            (isCustomModelCoder && !hasModelSwitch(modelCoder))
        ) {
            modelsTriggerBtn.disabled = true;
            modelsTriggerBtn.classList.add('disabled');
            modelsTriggerBtn.title =
                modelCoder === 'agy'
                    ? 'Model selection not supported for Antigravity'
                    : 'Model selection not supported for this coder';
        } else {
            modelsTriggerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleDropup(
                    'model-presets-dropup',
                    modelsTriggerBtn,
                    () => this.renderModelDropup(),
                );
            });
        }
        this.presetsContainer.appendChild(modelsTriggerBtn);

        // Skills picker: only on bridge-live Pi tabs that negotiated
        // the skills capability. Without it the composer keeps exactly
        // the controls it had, so a missing bridge adds no dead button.
        if (modelCoder === 'pi' && this._piBridgeSkillsEligible(activeTab)) {
            const skillsTriggerBtn = document.createElement('button');
            skillsTriggerBtn.type = 'button';
            skillsTriggerBtn.className =
                'preset-btn model-trigger-btn pi-rpc-skills-trigger';
            skillsTriggerBtn.textContent = 'Skills ▾';
            skillsTriggerBtn.disabled =
                activeTab.isDead === true ||
                !activeTab.ws ||
                activeTab.ws.readyState === 3;
            skillsTriggerBtn.title = 'Send a Pi skill to the session';
            skillsTriggerBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                if (
                    skillsTriggerBtn.disabled ||
                    this.getActiveTab() !== activeTab ||
                    this.tabs?.get(activeTab.paneId) !== activeTab
                )
                    return;
                if (!this._piBridgeSkillsEligible(activeTab)) {
                    this._closePiRpcDropups(true);
                    return;
                }
                this._toggleDropup(
                    'pi-rpc-skills-dropup',
                    skillsTriggerBtn,
                    () => this._renderPiRpcSkillsDropup(),
                );
            });
            this.presetsContainer.appendChild(skillsTriggerBtn);
        }

        if (modelCoder === 'pi') {
            const thinkingTriggerBtn = document.createElement('button');
            thinkingTriggerBtn.type = 'button';
            thinkingTriggerBtn.className =
                'preset-btn model-trigger-btn pi-rpc-thinking-trigger';
            thinkingTriggerBtn.textContent = 'Thinking ▾';
            thinkingTriggerBtn.disabled =
                activeTab.isDead === true ||
                !activeTab.ws ||
                activeTab.ws.readyState === 3;
            thinkingTriggerBtn.title = this._piBridgeThinkingEligible(activeTab)
                ? `Thinking · ${activeTab.piBridge.thinking_level || '—'}`
                : 'Open Pi native Thinking picker';
            thinkingTriggerBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                if (
                    thinkingTriggerBtn.disabled ||
                    this.getActiveTab() !== activeTab ||
                    this.tabs?.get(activeTab.paneId) !== activeTab
                )
                    return;
                if (this._piBridgeThinkingEligible(activeTab)) {
                    this._toggleDropup(
                        'pi-rpc-thinking-dropup',
                        thinkingTriggerBtn,
                        () => this._renderPiRpcThinkingDropup(),
                    );
                } else {
                    this.sendSlashCommand(activeTab, '/thinking');
                }
            });
            this.presetsContainer.appendChild(thinkingTriggerBtn);
        }

        // 4b. Render Keys trigger button (keyboard icon only)
        const keysTriggerBtn = document.createElement('button');
        keysTriggerBtn.className =
            'preset-btn model-trigger-btn keys-trigger-btn';
        keysTriggerBtn.title = 'Virtual Keyboard & Shortcuts';
        keysTriggerBtn.setAttribute(
            'aria-label',
            'Virtual Keyboard and Shortcuts',
        );
        keysTriggerBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle;"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect><line x1="6" y1="8" x2="6" y2="8"></line><line x1="10" y1="8" x2="10" y2="8"></line><line x1="14" y1="8" x2="14" y2="8"></line><line x1="18" y1="8" x2="18" y2="8"></line><line x1="6" y1="12" x2="6" y2="12"></line><line x1="10" y1="12" x2="10" y2="12"></line><line x1="14" y1="12" x2="14" y2="12"></line><line x1="18" y1="12" x2="18" y2="12"></line><line x1="7" y1="16" x2="17" y2="16"></line></svg>`;
        keysTriggerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleDropup('keys-presets-dropup', keysTriggerBtn, () =>
                this.renderKeysDropup(),
            );
        });
        this.presetsContainer.appendChild(keysTriggerBtn);

        // Auto-refresh dropup content if currently open
        const dropup = document.getElementById('model-presets-dropup');
        if (dropup && !dropup.classList.contains('hidden')) {
            this.renderModelDropup();
        }
        if (coderId === 'pi' && this._piBridgeModelsEligible(activeTab)) {
            const mDropup = document.getElementById('pi-rpc-model-dropup');
            if (mDropup && !mDropup.classList.contains('hidden')) {
                this._renderPiRpcModelsDropup(true);
            }
        }
        if (coderId === 'pi' && this._piBridgeThinkingEligible(activeTab)) {
            const tDropup = document.getElementById('pi-rpc-thinking-dropup');
            if (tDropup && !tDropup.classList.contains('hidden'))
                this._renderPiRpcThinkingDropup();
        }
        const qcDropup = document.getElementById('quick-commands-dropup');
        if (qcDropup && !qcDropup.classList.contains('hidden')) {
            this.renderQuickCmdsDropup();
        }
        const keysDropup = document.getElementById('keys-presets-dropup');
        if (keysDropup && !keysDropup.classList.contains('hidden')) {
            this.renderKeysDropup();
        }
        const slashDropup = document.getElementById('slash-presets-dropup');
        if (slashDropup && !slashDropup.classList.contains('hidden')) {
            const slashPresets = coderPresetInfo
                ? coderPresetInfo.presets.filter((p) => p.value.startsWith('/'))
                : [];
            this.renderSlashDropup(slashPresets);
        }

        // 5. Render mobile virtual navigation keys (arrows) to compensate for touch keyboard limits
        if (isMobile) {
            const divider = document.createElement('div');
            divider.className = 'presets-divider';
            this.presetsContainer.appendChild(divider);

            const mobileNavs = [
                { name: '▲', value: '\u001b[A' },
                { name: '▼', value: '\u001b[B' },
                { name: '◀', value: '\u001b[D' },
                { name: '▶', value: '\u001b[C' },
            ];

            mobileNavs.forEach((nav) => {
                const btn = document.createElement('button');
                btn.className = 'preset-btn mobile-nav-btn';
                btn.innerText = nav.name;
                btn.addEventListener('click', () => {
                    this.sendRawInput(nav.value);
                });
                this.presetsContainer.appendChild(btn);
            });
        }
        this._updatePiThinkingButton();
    }

    renderSlashDropup(slashPresets) {
        const dropup = document.getElementById('slash-presets-dropup');
        if (!dropup) return;
        dropup.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'dropup-header';
        header.innerText = 'Slash Commands';
        dropup.appendChild(header);

        if (slashPresets.length === 0) {
            const row = document.createElement('div');
            row.className = 'dropup-row';
            row.style.color = 'var(--text-muted)';
            row.style.padding = '8px 12px';
            row.style.fontSize = '12px';
            row.innerText = 'No commands';
            dropup.appendChild(row);
            return;
        }

        slashPresets.forEach((p) => {
            const row = document.createElement('div');
            row.className = 'dropup-row';

            const btn = document.createElement('button');
            btn.className = 'dropup-model-btn';
            btn.innerText = p.name;
            if (
                p.value === '/compact\r' &&
                this.getActiveTab()?.coder === 'pi'
            ) {
                const compactState = this._piBridgeCompactControlState(
                    this.getActiveTab(),
                );
                btn.disabled = compactState.disabled;
                if (compactState.title) btn.title = compactState.title;
            }
            btn.addEventListener('click', () => {
                const activeTab = this.getActiveTab();
                if (
                    activeTab &&
                    (activeTab.coder === 'opencode' ||
                        activeTab.coder === 'pi' ||
                        activeTab.coder === 'codex') &&
                    p.value.startsWith('/') &&
                    p.value.endsWith('\r')
                ) {
                    const cmd = p.value.slice(0, -1);
                    // OpenCode delays Enter after the paste; Pi stays atomic.
                    this.sendSlashCommand(activeTab, cmd, { focusInputOnMobile: false });
                } else {
                    this.sendRawInput(p.value, { focusInputOnMobile: false });
                }
                dropup.classList.add('hidden');
            });
            row.appendChild(btn);
            dropup.appendChild(row);
        });
    }

    _refreshHostnameTabsDropdown() {
        const dropdown = document.getElementById('hostname-tabs-dropdown');
        if (!dropdown || dropdown.classList.contains('hidden')) return;
        // A live settlement rebuilds the list; keep the keyboard user's
        // place (row + control) and the scroll offset across the rebuild.
        const active = document.activeElement;
        const focusRow = active?.closest?.('.hostname-dropdown-row') || null;
        const focusControl = focusRow?.contains(active)
            ? Array.from(focusRow.querySelectorAll('button')).indexOf(active)
            : -1;
        const focusPaneId =
            focusRow && dropdown.contains(focusRow)
                ? focusRow.dataset.paneId
                : null;
        const scrollTop = dropdown.scrollTop;
        this.renderHostnameTabsDropdown();
        dropdown.scrollTop = scrollTop;
        if (focusPaneId && focusControl >= 0) {
            // Equality match, never an interpolated selector: pane IDs
            // can carry quotes or backslashes (e.g. review-${id}), which
            // would throw here and interrupt completion handling.
            const row = Array.from(
                dropdown.querySelectorAll('.hostname-dropdown-row'),
            ).find(
                (candidate) => candidate.dataset.paneId === focusPaneId,
            );
            row?.querySelectorAll('button')[focusControl]?.focus({
                preventScroll: true,
            });
        }
    }

    renderHostnameTabsDropdown() {
        const dropdown = document.getElementById('hostname-tabs-dropdown');
        if (!dropdown) return;
        dropdown.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'dropup-header';
        header.style.borderBottom = '1px solid var(--bg-border)';
        header.style.padding = '6px 12px';
        header.style.color = 'var(--accent)';
        header.innerText = 'Active Sessions';
        dropdown.appendChild(header);

        if (this.tabs.size === 0) {
            const emptyItem = document.createElement('div');
            emptyItem.className = 'hostname-dropdown-item';
            emptyItem.style.color = 'var(--text-muted)';
            emptyItem.innerText = 'No active tabs';
            dropdown.appendChild(emptyItem);
            return;
        }

        const tabEntries = Array.from(this.tabs.entries());
        // Unread (needing attention) first; existing tab order secondary.
        // Closing rows get no unread priority during the undo grace period.
        const isListUnread = (tabInfo) =>
            !tabInfo.softClosing && tabInfo.isAttention;
        const orderedEntries = [
            ...tabEntries.filter(([, tabInfo]) => isListUnread(tabInfo)),
            ...tabEntries.filter(([, tabInfo]) => !isListUnread(tabInfo)),
        ];
        for (const [paneId, tabInfo] of orderedEntries) {
            const row = document.createElement('div');
            row.className = 'hostname-dropdown-row';
            row.dataset.paneId = paneId;
            if (paneId === this.activePaneId) {
                row.classList.add('active');
            }
            if (isListUnread(tabInfo)) row.classList.add('has-attention');

            // Click target to switch tab
            const selectBtn = document.createElement('button');
            selectBtn.className = 'hostname-dropdown-select-btn';

            // Coder favicon (icon-only — the coder prefix text was redundant
            // since the favicon already identifies the coder)
            const faviconImg = document.createElement('img');
            faviconImg.className = 'hostname-dropdown-favicon';
            faviconImg.src =
                logoFor(tabInfo.coder) ||
                CODER_FAVICONS[tabInfo.coder] ||
                'vendor/logos/bash.jpg';
            faviconImg.alt = tabInfo.coder;

            // Worktree hieroglyph — same glyph shown on the tab itself.
            // Ties the dropdown row to its worktree group at a glance.
            const glyphSpan = document.createElement('span');
            glyphSpan.className = 'hostname-dropdown-glyph';
            glyphSpan.setAttribute('aria-hidden', 'true');
            glyphSpan.textContent = tabInfo.tabEl?.dataset.worktreeGlyph || '◆';

            const titleSpan = document.createElement('span');
            titleSpan.className = 'hostname-dropdown-title';
            if (tabInfo.marked) {
                titleSpan.classList.add('marked');
            }
            titleSpan.innerText = tabInfo.title || 'Session';

            const metaSpan = document.createElement('span');
            metaSpan.className = 'hostname-dropdown-meta';
            // Show project/worktree path instead of redundant status
            metaSpan.innerText = this.getProjectWorktreeLabel(tabInfo.cwd);
            metaSpan.style.color = 'var(--text-muted)';
            metaSpan.style.fontSize = '10px';

            selectBtn.appendChild(faviconImg);
            selectBtn.appendChild(glyphSpan);
            selectBtn.appendChild(titleSpan);
            selectBtn.appendChild(metaSpan);
            if (isListUnread(tabInfo)) {
                selectBtn.appendChild(
                    this._makeAttentionMarker(
                        'hostname-dropdown-attention',
                        'Needs attention',
                    ),
                );
            }
            selectBtn.addEventListener('click', () => {
                this.switchTab(paneId, { userInitiated: true });
                dropdown.classList.add('hidden');
            });
            row.appendChild(selectBtn);

            // Marker button (toggles glow on session name)
            const markerBtn = document.createElement('button');
            markerBtn.className = 'hostname-dropdown-marker-btn';
            if (tabInfo.marked) {
                markerBtn.classList.add('marked');
            }
            markerBtn.innerHTML = '◆';
            markerBtn.title = 'Mark session (highlights in list)';
            markerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                tabInfo.marked = !tabInfo.marked;
                this.syncBackendMark(paneId, tabInfo.marked);
                this.renderHostnameTabsDropdown(); // refresh to show updated state
            });
            row.appendChild(markerBtn);

            // Pin button
            const pinBtn = document.createElement('button');
            pinBtn.className = 'hostname-dropdown-pin-btn';
            if (tabInfo.pinned) {
                pinBtn.classList.add('pinned');
            }
            pinBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>`;
            pinBtn.title = 'Pin session (Keep alive overnight)';
            pinBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.togglePinTab(paneId);
                this.renderHostnameTabsDropdown(); // refresh dropdown layout
            });
            row.appendChild(pinBtn);

            // Close button
            const closeBtn = document.createElement('button');
            closeBtn.className = 'hostname-dropdown-close-btn';
            closeBtn.innerHTML = '×';
            closeBtn.title = 'Close session';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`Close session: ${tabInfo.title || 'Session'}?`)) {
                    this.closeTab(paneId);
                    this.renderHostnameTabsDropdown(); // refresh dropdown layout
                }
            });
            row.appendChild(closeBtn);

            dropdown.appendChild(row);
        }
    }

    getProjectWorktreeLabel(cwd) {
        return projectWorktreeLabel(cwd);
    }

    async addModelPreset(backend) {
        const values = await this.app.openConfigEditor({
            title: 'Add Model Preset',
            subtitle: `Saved under ${backend}. Use the exact model identifier your backend expects.`,
            fields: [
                {
                    id: 'model',
                    label: 'Model identifier',
                    placeholder: 'provider/model-name',
                },
            ],
            submitLabel: 'Add Model',
        });
        if (!values) return;

        try {
            const res = await fetch('/api/config/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: values.model, coder: backend }),
            });
            if (!res.ok)
                throw new Error(
                    (await res.text()) || 'Failed to add model preset',
                );
            await this.app.sessionsManager.loadConfig();
            this.renderModelDropup();
            this.app.showToast(`Added model preset "${values.model}"`, {
                type: 'info',
                title: 'Models',
            });
        } catch (err) {
            console.error('Failed to add model preset:', err);
            this.app.showToast(err.message, { type: 'error', title: 'Models' });
        }
    }

    async editModelPreset(backend, model) {
        const values = await this.app.openConfigEditor({
            title: 'Edit Model Preset',
            subtitle: `Update the saved model identifier for ${backend}.`,
            fields: [
                {
                    id: 'model',
                    label: 'Model identifier',
                    value: model,
                    placeholder: 'provider/model-name',
                },
            ],
            submitLabel: 'Save Model',
        });
        if (!values || values.model === model) return;

        try {
            const res = await fetch('/api/config/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    old_model: model,
                    model: values.model,
                    coder: backend,
                }),
            });
            if (!res.ok)
                throw new Error(
                    (await res.text()) || 'Failed to edit model preset',
                );
            await this.app.sessionsManager.loadConfig();
            this.renderModelDropup();
            this.app.showToast(`Updated model preset "${values.model}"`, {
                type: 'info',
                title: 'Models',
            });
        } catch (err) {
            console.error('Failed to edit model preset:', err);
            this.app.showToast(err.message, { type: 'error', title: 'Models' });
        }
    }

    async addQuickCommand() {
        const values = await this.app.openConfigEditor({
            title: 'Add Quick Command',
            subtitle:
                'Quick commands run in the active terminal. Use {} as a placeholder for selected input text.',
            fields: [
                {
                    id: 'name',
                    label: 'Label',
                    placeholder: 'tests',
                    monospace: false,
                },
                {
                    id: 'command',
                    label: 'Command',
                    placeholder: 'npm test',
                    multiline: true,
                },
            ],
            submitLabel: 'Add Command',
        });
        if (!values) return;

        try {
            const res = await fetch('/api/config/quick-commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: values.name,
                    command: values.command,
                }),
            });
            if (!res.ok)
                throw new Error(
                    (await res.text()) || 'Failed to add quick command',
                );
            await this.app.sessionsManager.loadConfig();
            this.renderQuickCmdsDropup();
            this.app.showToast(`Added quick command "${values.name}"`, {
                type: 'info',
                title: 'Commands',
            });
        } catch (err) {
            console.error('Failed to add quick command:', err);
            this.app.showToast(err.message, {
                type: 'error',
                title: 'Commands',
            });
        }
    }

    async editQuickCommand(cmd) {
        const values = await this.app.openConfigEditor({
            title: 'Edit Quick Command',
            subtitle:
                'Rename the action or change the text sent to the active terminal.',
            fields: [
                {
                    id: 'name',
                    label: 'Label',
                    value: cmd.name,
                    monospace: false,
                },
                {
                    id: 'command',
                    label: 'Command',
                    value: cmd.command,
                    multiline: true,
                },
            ],
            submitLabel: 'Save Command',
        });
        if (
            !values ||
            (values.name === cmd.name && values.command === cmd.command)
        )
            return;

        try {
            const res = await fetch('/api/config/quick-commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    old_name: cmd.name,
                    name: values.name,
                    command: values.command,
                }),
            });
            if (!res.ok)
                throw new Error(
                    (await res.text()) || 'Failed to edit quick command',
                );
            await this.app.sessionsManager.loadConfig();
            this.renderQuickCmdsDropup();
            this.app.showToast(`Updated quick command "${values.name}"`, {
                type: 'info',
                title: 'Commands',
            });
        } catch (err) {
            console.error('Failed to edit quick command:', err);
            this.app.showToast(err.message, {
                type: 'error',
                title: 'Commands',
            });
        }
    }

    renderModelDropup() {
        const dropup = document.getElementById('model-presets-dropup');
        if (!dropup) return;
        dropup.innerHTML = '';

        const activeTab = this.getActiveTab();
        if (!activeTab) return;

        const backend = activeTab.coder;
        const allPresets = this.app.modelPresets || {};
        const modelPresets = [...(allPresets[backend] || [])].sort((a, b) =>
            a.localeCompare(b),
        );

        // 1. Header
        const header = document.createElement('div');
        header.className = 'dropup-header';
        header.innerText = 'Model Presets';
        dropup.appendChild(header);

        // 2. Render preset rows
        modelPresets.forEach((model) => {
            const row = document.createElement('div');
            row.className = 'dropup-row';

            const btn = document.createElement('button');
            btn.className = 'dropup-model-btn';
            btn.innerText = model;
            btn.addEventListener('click', () => {
                // Model-switch sequences are pinned to the click-time
                // tab (activeTab captured at render) so a tab switch
                // mid-chain cannot redirect the puppet sequence.
                //
                // Legacy OpenCode / Pi / Claude retain their historical
                // timings. Mini uses its own native command/model menus
                // through the bounded executor, with the same pane pin
                // and cancellation rules as custom recipes.
                let recipe = recipeFor(backend);
                if (isOpenCodeMini(activeTab)) {
                    try {
                        recipe = opencodeMiniRecipe(model);
                    } catch (err) {
                        this.app.showToast(err.message, { type: 'error', title: 'Models' });
                        return;
                    }
                }
                if (recipe) {
                    const paneId =
                        activeTab.paneId || activeTab.tabId || activeTab.id;
                    executeRecipe({
                        paneId,
                        recipe,
                        model,
                        sendFn: (id, payload) => {
                            const tab = this.app.tabManager?.tabs?.get?.(id);
                            return tab ? this.sendToTab(tab, payload) : false;
                        },
                        isAliveFn: (id) => {
                            const tab = this.app.tabManager?.tabs?.get?.(id);
                            if (!tab?.term) return false;
                            return !tab.isDead;
                        },
                    }).catch((err) => {
                        console.error('[model-switch] recipe aborted:', err);
                    });
                    dropup.classList.add('hidden');
                    return;
                }
                if (backend === 'opencode') {
                    // Pinned to the click-time tab (captured at render, line 4376)
                    // so the puppet sequence can't be redirected by a tab switch
                    // mid-chain. Timing unchanged from prior behavior.
                    this.sendToTab(activeTab, '/models');
                    setTimeout(() => {
                        this.sendToTab(activeTab, '\r');
                        setTimeout(() => {
                            this.sendToTab(activeTab, model);
                            setTimeout(() => {
                                this.sendToTab(activeTab, '\r');
                            }, 350);
                        }, 350);
                    }, 350);
                } else if (backend === 'pi') {
                    // /model <id> [PAUSE] <Esc> [PAUSE] <Enter>, every send
                    // pinned to the tab clicked above.
                    //
                    // The Esc is the load-bearing step. Typing `/model` opens
                    // pi-tui's command autocomplete, and while that dropdown
                    // is up it consumes Enter to accept its own highlighted
                    // entry -- so an Enter sent straight after the identifier
                    // submits whatever the dropdown had selected instead of
                    // the line we typed. Esc dismisses the dropdown, leaving
                    // the typed text intact, and the following Enter then
                    // submits that text.
                    //
                    // A PAUSE is not an Enter. It is only time, letting pi-tui
                    // render one state before the next key arrives; Enter is a
                    // commit keystroke. Earlier revisions of this sequence
                    // conflated the two (see 0e18ebc, f5b0d54, de9562e).
                    //
                    // Do not collapse this into a bracketed paste: pasting
                    // bundles the keys into one event, so the dropdown never
                    // opens, the Esc has nothing to dismiss, and the Enter
                    // lands in whatever state pi-tui happened to be in.
                    this.sendToTab(activeTab, `/model ${model}`);
                    setTimeout(() => {
                        this.sendToTab(activeTab, '\x1b');
                        setTimeout(() => {
                            this.sendToTab(activeTab, '\r');
                        }, PI_MODEL_STEP_MS);
                    }, PI_MODEL_STEP_MS);
                } else if (backend === 'claude') {
                    // Claude may show a model-switch cache warning after the
                    // command resolves. The second Enter acknowledges it.
                    // Pin it to the clicked tab just like the other delayed
                    // backend-specific model flows.
                    this.sendToTab(activeTab, `/model ${model}\r`);
                    setTimeout(() => {
                        this.sendToTab(activeTab, '\r');
                    }, 500);
                } else if (
                    backend === 'bash' ||
                    backend === 'pwsh' ||
                    !getCoder(backend)
                ) {
                    // Preserve the legacy shell/unknown-tab behavior;
                    // never guess a command for a registered custom backend.
                    this.sendRawInput(`/model ${model}\r`);
                }
                dropup.classList.add('hidden');
            });
            row.appendChild(btn);

            const actionsContainer = document.createElement('div');
            actionsContainer.className = 'dropup-row-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'dropup-action-btn dropup-edit-btn';
            editBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
            editBtn.title = `Edit model preset ${model}`;
            editBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.editModelPreset(backend, model);
            });
            actionsContainer.appendChild(editBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'dropup-action-btn dropup-del-btn';
            delBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
            delBtn.title = `Delete model preset ${model}`;
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm(`Remove model preset "${model}"?`)) {
                    try {
                        await fetch('/api/config/models', {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ model, coder: backend }),
                        });
                        await this.app.sessionsManager.loadConfig();
                    } catch (err) {
                        console.error('Failed to delete model preset:', err);
                    }
                }
            });
            actionsContainer.appendChild(delBtn);
            row.appendChild(actionsContainer);
            dropup.appendChild(row);
        });

        // 3. Add Preset Action Row
        const addRow = document.createElement('div');
        addRow.className = 'dropup-add-row';

        const addBtn = document.createElement('button');
        addBtn.className = 'dropup-add-btn';
        addBtn.innerText = '+ Add Model Preset...';
        addBtn.addEventListener('click', async () => {
            await this.addModelPreset(backend);
        });
        addRow.appendChild(addBtn);
        dropup.appendChild(addRow);

        // 4. Config Copy/Paste Footer
        this._appendConfigFooter(dropup, 'models');
    }

    renderQuickCmdsDropup() {
        const dropup = document.getElementById('quick-commands-dropup');
        if (!dropup) return;
        dropup.innerHTML = '';

        const quickCmds = this.app.quickCommands || [];

        const header = document.createElement('div');
        header.className = 'dropup-header';
        header.innerText = 'Quick Commands';
        dropup.appendChild(header);

        quickCmds.forEach((cmd) => {
            const row = document.createElement('div');
            row.className = 'dropup-row';

            const btn = document.createElement('button');
            btn.className = 'dropup-model-btn';
            btn.innerText = cmd.name;
            btn.title = cmd.command;
            btn.addEventListener('click', () => {
                const activeTab = this.getActiveTab();
                if (!activeTab || activeTab.coder === 'pi-rpc') return;
                const prefix = this.inputTextArea.value.trim();
                const combined =
                    prefix && cmd.command.includes('{}')
                        ? cmd.command.replace('{}', prefix)
                        : prefix
                          ? `${prefix} ${cmd.command}`
                          : cmd.command;
                let payload = combined;
                if (
                    activeTab.coder === 'codex' ||
                    combined.length > 16 ||
                    combined.includes('\n')
                ) {
                    payload = `\x1b[200~${combined}\x1b[201~`;
                }
                this.sendInput(activeTab, `${payload}\r`);
                this.inputTextArea.value = '';
                this.lastInputValue = '';
                this.saveActiveDraft();
                this.adjustInputHeight();
                if (prefersInputBarFocus()) {
                    this.inputTextArea.blur();
                } else {
                    this.inputTextArea.focus({ preventScroll: true });
                }
                this._spamScrollToBottom(activeTab);
                dropup.classList.add('hidden');
            });
            row.appendChild(btn);

            const actionsContainer = document.createElement('div');
            actionsContainer.className = 'dropup-row-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'dropup-action-btn dropup-edit-btn';
            editBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
            editBtn.title = `Edit quick command "${cmd.name}"`;
            editBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.editQuickCommand(cmd);
            });
            actionsContainer.appendChild(editBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'dropup-action-btn dropup-del-btn';
            delBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 12px; height: 12px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
            delBtn.title = `Delete quick command "${cmd.name}"`;
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm(`Remove quick command "${cmd.name}"?`)) {
                    try {
                        await fetch('/api/config/quick-commands', {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: cmd.name }),
                        });
                        await this.app.sessionsManager.loadConfig();
                    } catch (err) {
                        console.error('Failed to delete quick command:', err);
                    }
                }
            });
            actionsContainer.appendChild(delBtn);
            row.appendChild(actionsContainer);
            dropup.appendChild(row);
        });

        const addRow = document.createElement('div');
        addRow.className = 'dropup-add-row';

        const addBtn = document.createElement('button');
        addBtn.className = 'dropup-add-btn';
        addBtn.innerText = '+ Add Command...';
        addBtn.addEventListener('click', async () => {
            await this.addQuickCommand();
        });
        addRow.appendChild(addBtn);
        dropup.appendChild(addRow);

        // Config Copy/Paste Footer
        this._appendConfigFooter(dropup, 'cmds');
    }

    renderKeysDropup() {
        const dropup = document.getElementById('keys-presets-dropup');
        if (!dropup) return;
        dropup.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'dropup-header kb-dropup-header';

        const titleSpan = document.createElement('span');
        titleSpan.innerText = 'Virtual Keys';
        header.appendChild(titleSpan);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'kb-dropup-close-btn';
        closeBtn.innerText = '✕';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropup.classList.add('hidden');
        });
        header.appendChild(closeBtn);
        dropup.appendChild(header);

        const body = document.createElement('div');
        body.className = 'kb-dropup-body';

        const groups = [
            {
                title: 'Navigation',
                keys: [
                    {
                        label: 'Home',
                        title: 'Home (Line Start)',
                        value: '\x1b[H',
                    },
                    { label: '▲', title: 'Up Arrow', value: '\x1b[A' },
                    { label: 'End', title: 'End (Line End)', value: '\x1b[F' },
                    { label: 'PgUp', title: 'Page Up', value: '\x1b[5~' },
                    { label: '◀', title: 'Left Arrow', value: '\x1b[D' },
                    { label: '▼', title: 'Down Arrow', value: '\x1b[B' },
                    { label: '▶', title: 'Right Arrow', value: '\x1b[C' },
                    { label: 'PgDn', title: 'Page Down', value: '\x1b[6~' },
                ],
            },
            {
                title: 'Keys & Modifiers',
                keys: [
                    {
                        label: 'Shift+Tab',
                        title: 'Backtab (Shift+Tab)',
                        value: '\x1b[Z',
                        span: 2,
                    },
                    { label: 'Tab', title: 'Tab', value: '\t' },
                    { label: 'Esc', title: 'Escape', value: '\x1b' },
                    {
                        label: 'Del',
                        title: 'Forward Delete',
                        value: '\x1b[3~',
                        span: 2,
                    },
                    {
                        label: 'Enter ↵',
                        title: 'Enter (Carriage Return)',
                        value: '\r',
                        span: 2,
                    },
                ],
            },
            {
                title: 'Control Shortcuts',
                keys: [
                    {
                        label: 'Ctrl+C',
                        title: 'Interrupt (SIGINT)',
                        value: '\x03',
                    },
                    {
                        label: 'Ctrl+D',
                        title: 'EOF / Exit Shell',
                        value: '\x04',
                    },
                    {
                        label: 'Ctrl+Z',
                        title: 'Suspend Process (SIGTSTP)',
                        value: '\x1a',
                    },
                    { label: 'Ctrl+L', title: 'Clear Screen', value: '\x0c' },
                    {
                        label: 'Ctrl+R',
                        title: 'Reverse History Search',
                        value: '\x12',
                    },
                    { label: 'Ctrl+A', title: 'Start of Line', value: '\x01' },
                    { label: 'Ctrl+E', title: 'End of Line', value: '\x05' },
                    {
                        label: 'Ctrl+U',
                        title: 'Clear Line to Cursor',
                        value: '\x15',
                    },
                ],
            },
        ];

        groups.forEach((group) => {
            const groupEl = document.createElement('div');
            groupEl.className = 'kb-group';

            const groupTitle = document.createElement('div');
            groupTitle.className = 'kb-group-title';
            groupTitle.innerText = group.title;
            groupEl.appendChild(groupTitle);

            const grid = document.createElement('div');
            grid.className = 'kb-grid';

            group.keys.forEach((k) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `kb-key-btn${k.span ? ` span-${k.span}` : ''}`;
                btn.innerText = k.label;
                btn.title = k.title || k.label;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const activeTab = this.getActiveTab();
                    if (!activeTab || activeTab.coder === 'pi-rpc') return;
                    this.sendRawInput(k.value, { focusInputOnMobile: false });
                    btn.classList.add('key-pressed');
                    setTimeout(() => btn.classList.remove('key-pressed'), 120);
                });
                grid.appendChild(btn);
            });

            groupEl.appendChild(grid);
            body.appendChild(groupEl);
        });

        dropup.appendChild(body);
    }

    _appendConfigFooter(dropup, mode = 'models') {
        const footer = document.createElement('div');
        footer.className = 'dropup-config-footer';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'dropup-config-btn';
        copyBtn.title =
            mode === 'cmds'
                ? 'Copy commands config to clipboard'
                : 'Copy models config to clipboard';
        copyBtn.innerHTML = '↑ Copy config';
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (mode === 'cmds') {
                // Right-side cmds = quick commands (sent to the active PTY).
                this.app.exportQuickCommandsConfig(copyBtn);
            } else {
                this.app.exportModelsConfig(copyBtn);
            }
        });

        const pasteBtn = document.createElement('button');
        pasteBtn.className = 'dropup-config-btn';
        pasteBtn.title =
            mode === 'cmds'
                ? 'Paste commands config from clipboard'
                : 'Paste models config from clipboard';
        pasteBtn.innerHTML = '↓ Paste config';
        pasteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (mode === 'cmds') {
                await this.app.importCmdsConfig(pasteBtn);
            } else {
                await this.app.importModelsConfig(pasteBtn);
            }
            document.querySelectorAll('.model-presets-dropup').forEach((d) => {
                d.classList.add('hidden');
            });
            const activeTab = this.getActiveTab();
            if (activeTab) {
                this.renderPresets(activeTab.coder);
            }
        });

        footer.appendChild(copyBtn);
        footer.appendChild(pasteBtn);
        dropup.appendChild(footer);
    }

    getTerminalTheme(coder, accentColorKeyOrHex) {
        return getTerminalTheme(coder, accentColorKeyOrHex, this.app?.config);
    }

    applyThemeToAllActiveTerminals(color) {
        const activeColor =
            color ||
            (typeof document !== 'undefined' &&
                document.documentElement?.style?.getPropertyValue(
                    '--accent',
                )) ||
            '#7c6af7';
        for (const tab of this.tabs.values()) {
            if (tab.term) {
                tab.term.options.theme = this.getTerminalTheme(
                    tab.coder,
                    activeColor,
                );
            }
        }
    }

    // Resolve a preferred reading scale against FitAddon's actual grid.
    // This is deliberately separate from fitting/scroll restoration: it only
    // chooses options.fontSize before the existing fit path runs, leaving the
    // hard-won _spamScroll timing behavior untouched.
    resolveTerminalFontSize(
        tab,
        preference = this.app?.terminalFontSize,
        proposed,
    ) {
        // The caller may pass pre-measured proposeDimensions so the fit
        // path measures the DOM once and reuses it for the skip check.
        const dims = proposed ?? tab?.fitAddon?.proposeDimensions?.();
        return responsiveTerminalFontSize(
            terminalPreferredFontSize(preference),
            Number(tab?.term?.options?.fontSize),
            dims?.cols,
            TERMINAL_TARGET_COLUMNS,
        );
    }

    // applyFontToAllActiveTerminals sets a new fontFamily on every
    // live xterm. Hidden viewport fits wait until activation.
    // Empty/invalid input falls back to 'JetBrains Mono, monospace'.
    // Deliberately does NOT touch any scroll / _spamScroll timing
    // (see AGENTS.md hard-won-stabilization rule).
    applyFontToAllActiveTerminals(family) {
        const safe =
            (family && String(family).trim()) || 'JetBrains Mono, monospace';
        for (const tab of this.tabs.values()) {
            if (tab.term) {
                tab.term.options.fontFamily = safe;
                if (tab.fitAddon && typeof tab.fitAddon.fit === 'function') {
                    try {
                        this._fitVisibleTerminal(tab);
                    } catch (_e) {
                        /* tolerate closed term */
                    }
                }
            }
        }
        // Diff panel xterm lives on app.diffController (not in this.tabs), so
        // the loop above misses it. Route through the controller's live-apply
        // hook so the diff screen honors the family picker alongside size.
        this.app.diffController?.applyFontFamily?.(safe);
    }

    // applyTerminalFontSizeToAll sets a new fontSize on every live xterm,
    // then fits visible panels and sends their geometry to the backend PTY.
    // Hidden fits wait until activation. Deliberately does NOT touch any
    // scroll / _spamScroll timing (see AGENTS.md hard-won-stabilization rule).
    applyTerminalFontSizeToAll(size) {
        const preferred = terminalPreferredFontSize(size);
        const activeTab = this.getActiveTab();
        for (const tab of this.tabs.values()) {
            if (!tab.term) continue;
            // A hidden xterm has no meaningful proposed dimensions. Keep its
            // preferred scale; activation resolves it once it has a viewport.
            const resolved =
                tab === activeTab && this._terminalPanelVisible(tab)
                    ? this.resolveTerminalFontSize(tab, preferred)
                    : preferred;
            if (tab.term.options.fontSize === resolved) continue;
            tab.term.options.fontSize = resolved;
            if (tab.fitAddon && typeof tab.fitAddon.fit === 'function') {
                try {
                    this._fitVisibleTerminal(tab);
                    this.sendResizeToBackend(tab);
                } catch (_e) {
                    /* tolerate closed term */
                }
            }
        }
        // Diff's xterm is outside this.tabs. Its controller uses the same
        // preference-as-scale policy against its own measured grid.
        this.app.diffController?.applyFontSize?.();
    }

    pollTerminalIdleAndNotifications() {
        const isTabVisible = !document.hidden;
        let statusChanged = false;

        for (const tab of this.tabs.values()) {
            if (tab.isDead) continue;

            const isActiveAndVisible =
                tab.paneId === this.activePaneId && isTabVisible;

            // If the tab is currently focused and visible, clear attention states immediately.
            if (isActiveAndVisible) {
                if (tab.isAttention) {
                    this._setTabAttention(tab, false);
                    statusChanged = true;
                }
                // When actively focused on this tab, user sees it live: clear active task state once quiet/prompt
                if (tab.userTaskActive) {
                    const bufferState = detectTerminalBufferState(tab.term);
                    if (bufferState.hasPrompt || !tab.isBusy) {
                        tab.userTaskActive = false;
                        tab.busyStartTime = null;
                    }
                }
            }

            // Track busy-to-idle transition for active terminal connections.
            if (tab.isBusy && tab.lastOutputAt !== undefined) {
                const idleTime = Date.now() - tab.lastOutputAt;
                if (idleTime > 3000) {
                    // Output has stopped for 3 seconds. The PTY transitioned to idle!
                    tab.isBusy = false;
                    statusChanged = true;

                    // Release backend pin if NOT manually pinned by the user.
                    if (!tab.pinned) {
                        this.syncBackendPin(tab.paneId, false);
                    }

                    // Calculate total execution duration
                    const totalDuration =
                        Date.now() -
                        (tab.busyStartTime ||
                            tab.userTaskStartTime ||
                            Date.now());
                    const isLongTask = totalDuration > 4000;

                    // Only notify if this tab is NOT currently active and focused, was a running task, and is NOT a shell tab.
                    const isShellTab =
                        isShell(tab.coder) ||
                        tab.coder === 'bash' ||
                        tab.coder === 'pwsh';
                    // Bridge-managed Pi panes ring only on explicit
                    // settlements once the bridge is live: solid signal
                    // replaces the heuristic guess. Managed-but-never-
                    // connected panes (bridge disabled in Pi, manual
                    // install missing, Pi crashed pre-hello) keep the
                    // heuristic as a fallback, so a silent bridge never
                    // means no signal at all. Unavailable panes likewise.
                    const isBridgeActive =
                        tab.piBridge?.state === 'managed' &&
                        tab._piBridgeLive === true;

                    if (
                        !isActiveAndVisible &&
                        !isShellTab &&
                        !isBridgeActive
                    ) {
                        const taskWasRunning =
                            tab.userTaskActive === true ||
                            (tab.userTaskActive === undefined && isLongTask);

                        if (taskWasRunning) {
                            const bufferState = detectTerminalBufferState(
                                tab.term,
                            );

                            if (bufferState.hasSpinner) {
                                // Coding agent is still spinning / actively working despite output pause!
                                // Do not mark as done. Keep userTaskActive = true so completion can be
                                // caught once the spinner disappears and prompt arrives.
                            } else {
                                const promptDetected = bufferState.hasPrompt;
                                const processExited =
                                    tab.exitCode !== undefined &&
                                    tab.exitCode !== null;
                                const isTestMockWithoutTerm =
                                    !tab.term?.buffer?.active;

                                if (
                                    promptDetected ||
                                    processExited ||
                                    (isTestMockWithoutTerm && isLongTask)
                                ) {
                                    this._setTabAttention(tab, true);
                                    tab.userTaskActive = false;
                                    tab.busyStartTime = null;
                                    statusChanged = true;

                                    this.triggerAttentionNotification(
                                        tab,
                                        promptDetected,
                                    );
                                }
                            }
                        }
                    }

                    // Reset busyStartTime once quiescent if not retained by an active spinner task
                    if (!tab.userTaskActive) {
                        tab.busyStartTime = null;
                    }
                }
            }
        }

        // A single render after the scan covers both the ϕ → Φ quiet
        // transition and any completion attention marker without title churn.
        if (statusChanged) this.updateDocumentTitle();
    }

    triggerAttentionNotification(tab, promptDetected) {
        const message = promptDetected
            ? `Session "${tab.title}" is waiting at a prompt.`
            : `Session "${tab.title}" completed execution.`;

        // 1. Show in-app toast notification.
        if (this.app && typeof this.app.showToast === 'function') {
            this.app.showToast(message, {
                title: 'Task Done',
                type: 'info',
                duration: 6000,
                action: {
                    text: 'Go to tab',
                    callback: () =>
                        this.switchTab(tab.paneId, { userInitiated: true }),
                },
            });
        }

        // 2. Play subtle chime if backgrounded.
        if (!doneChimeAudio) {
            doneChimeAudio = new Audio('vendor/bell.wav');
            doneChimeAudio.volume = 0.2;
        }
        doneChimeAudio.currentTime = 0;
        doneChimeAudio.play().catch(() => {});

        // 3. Show OS-level notification if tab is hidden / not active.
        if (
            document.hidden &&
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted'
        ) {
            try {
                const n = new Notification('Phi Session Done', {
                    body: message,
                    tag: `phi-pane-${tab.paneId}`,
                    icon: 'screenshot.png',
                    silent: true,
                });
                n.onclick = () => {
                    window.focus();
                    this.switchTab(tab.paneId, { userInitiated: true });
                    n.close();
                };
            } catch (e) {
                console.error(
                    '[notification] Failed to show OS notification:',
                    e,
                );
            }
        }
    }

    _setTabAttention(tab, attention) {
        if (Boolean(tab.isAttention) === attention) return false;
        tab.isAttention = attention;
        if (tab.tabEl) {
            tab.tabEl.classList.toggle('has-attention', attention);
            const indicator = tab.tabEl.querySelector(
                '.tab-attention-indicator',
            );
            if (attention && !indicator) {
                const status = document.createElement('span');
                status.className = 'tab-attention-indicator';
                status.setAttribute('role', 'img');
                status.setAttribute('aria-label', 'Needs attention');
                status.textContent = '●';
                tab.tabEl.insertBefore(
                    status,
                    tab.tabEl.querySelector('.tab-title'),
                );
            } else if (!attention) {
                indicator?.remove();
            }
        }
        this._refreshOverflowDropdown?.();
        this._refreshHostnameTabsDropdown?.();
        return true;
    }

    clearAttentionIndicators() {
        // Clear the completion/attention layer, then recompose the title.
        // This intentionally preserves ϕ when another tab is still emitting.
        let cleared = false;
        for (const tab of this.tabs.values()) {
            if (this._setTabAttention(tab, false)) cleared = true;
        }
        if (cleared) this.updateDocumentTitle();
    }

    // _cyclePromptHistory advances/retreats through the user's previously
    // sent prompts for the active cwd. direction is 'older' (Alt+Up) or
    // 'newer' (Alt+Down). On first call for a cwd, fetches from the
    // server; subsequent calls walk the in-memory cache. Replaces the
    // textarea value and places the cursor at the end.
    //
    // Cursor semantics: -1 = free-form textarea (no entry shown). Any
    // non-negative index is an offset into _historyCache. Pressing Alt+Up
    // from -1 jumps to 0 (newest). Pressing Alt+Up from 0 jumps to 1
    // (older). Pressing Alt+Down decrements; reaching -1 restores the
    // pre-cycle value (saved in _historyPreCycleValue).
    async _cyclePromptHistory(direction) {
        if (!this.inputTextArea) return;

        // Capture the value before any cycle starts so Alt+Down can
        // return to it.
        if (this._historyCursor === -1 && direction === 'newer') {
            return; // already at the "newest" position
        }
        // An Alt-history cycle replaces the textarea, so it abandons
        // any Pi recall cycle (flushing a deferred arrow first).
        this._resetPiRecall({ flush: true });
        if (
            this._historyPreCycleValue === undefined &&
            this._historyCursor === -1
        ) {
            this._historyPreCycleValue = this.inputTextArea.value;
        }

        const cwd = this.app.sessionsManager?.activeCWD || '';
        if (cwd !== this._historyCwd || !this._historyLoaded) {
            // Lazy-load the cache for this cwd.
            const ok = await this._loadPromptHistory(cwd);
            if (!ok) return;
        }
        if (this._historyCache.length === 0) {
            return; // nothing to cycle through
        }

        if (direction === 'older') {
            this._historyCursor = Math.min(
                this._historyCursor < 0 ? 0 : this._historyCursor + 1,
                this._historyCache.length - 1,
            );
        } else {
            // 'newer' (Alt+Down)
            if (this._historyCursor <= 0) {
                // Past the newest — restore pre-cycle value.
                this.inputTextArea.value = this._historyPreCycleValue || '';
                this._historyCursor = -1;
                this._historyPreCycleValue = undefined;
                this._placeCursorAtEnd();
                this.adjustInputHeight();
                return;
            }
            this._historyCursor -= 1;
        }

        const entry = this._historyCache[this._historyCursor];
        if (entry) {
            // The local-history fetch may have overlapped a Pi read.
            this._resetPiRecall({ flush: true });
            this.inputTextArea.value = entry.text;
            this._placeCursorAtEnd();
            this.adjustInputHeight();
        }
    }

    // _caretOnFirstLine / _caretOnLastLine gate per-chat history cycling so
    // plain arrows still move the caret inside multiline drafts. True when no
    // newline sits before (after) the caret; the caller guarantees a
    // collapsed selection.
    _caretOnFirstLine() {
        if (!this.inputTextArea) return false;
        return !this.inputTextArea.value
            .slice(0, this.inputTextArea.selectionStart)
            .includes('\n');
    }

    _caretOnLastLine() {
        if (!this.inputTextArea) return false;
        return !this.inputTextArea.value
            .slice(this.inputTextArea.selectionEnd)
            .includes('\n');
    }

    // _cycleChatHistory walks the active Pi RPC tab's per-chat prompt history
    // (recorded in sendStagedInput). Mirrors _cyclePromptHistory's cursor
    // semantics — -1 = free-form draft, non-negative = index into
    // tab.promptHistory, the first 'older' saves the draft in
    // tab.chatHistoryPreCycleValue and 'newer' past 0 restores it — minus the
    // async server load.
    _cycleChatHistory(direction, tab) {
        if (!this.inputTextArea || !tab) return false;
        const history = Array.isArray(tab.promptHistory)
            ? tab.promptHistory
            : [];
        if (history.length === 0) return false;
        if (tab.chatHistoryCursor === undefined) tab.chatHistoryCursor = -1;
        if (direction === 'newer' && tab.chatHistoryCursor === -1) return false;
        if (
            tab.chatHistoryPreCycleValue === undefined &&
            tab.chatHistoryCursor === -1
        ) {
            tab.chatHistoryPreCycleValue = this.inputTextArea.value;
        }
        if (direction === 'older') {
            tab.chatHistoryCursor = Math.min(
                tab.chatHistoryCursor < 0 ? 0 : tab.chatHistoryCursor + 1,
                history.length - 1,
            );
        } else {
            if (tab.chatHistoryCursor <= 0) {
                this.inputTextArea.value = tab.chatHistoryPreCycleValue || '';
                tab.chatHistoryCursor = -1;
                tab.chatHistoryPreCycleValue = undefined;
                this._placeCursorAtEnd();
                this.adjustInputHeight();
                return true;
            }
            tab.chatHistoryCursor -= 1;
        }
        const entry = history[tab.chatHistoryCursor];
        if (entry === undefined) return false;
        this.inputTextArea.value = entry;
        this._placeCursorAtEnd();
        this.adjustInputHeight();
        return true;
    }

    _placeCursorAtEnd() {
        if (!this.inputTextArea) return;
        const len = this.inputTextArea.value.length;
        this.inputTextArea.setSelectionRange(len, len);
    }

    async _loadPromptHistory(cwd) {
        try {
            const res = await fetch(
                `/api/prompt-history/recent?cwd=${encodeURIComponent(cwd)}&n=50`,
            );
            if (!res.ok) return false;
            const entries = await res.json();
            if (!Array.isArray(entries)) return false;
            // Server returns newest-first; cache as-is.
            this._historyCache = entries;
            this._historyCwd = cwd;
            this._historyLoaded = true;
            // Do NOT touch _historyCursor / _historyPreCycleValue here:
            // _cyclePromptHistory captures the pre-cycle draft (and
            // reads/advances the cursor) around this call, and this
            // load can run mid-cycle. Clobbering either field here
            // would drop the user's draft on the first Alt+Up.
            return true;
        } catch (err) {
            console.warn('[prompt_history] load failed', err);
            return false;
        }
    }

    _piRecallEligible(tab) {
        return (
            tab?.coder === 'pi' && !tab.isDead &&
            tab.piBridge?.state === 'managed' &&
            tab.piBridge.connected === true &&
            Array.isArray(tab.piBridge.capabilities) &&
            tab.piBridge.capabilities.includes('pi.history.v1')
        );
    }

    // The shared model picker needs the models capability; anything
    // else keeps the legacy static presets exactly.
    _piBridgeModelsEligible(tab) {
        return (
            tab?.coder === 'pi' && !tab.isDead &&
            !!tab.ws && tab._piBridgeFresh === tab.ws &&
            tab.piBridge?.state === 'managed' &&
            tab.piBridge.connected === true &&
            Array.isArray(tab.piBridge.capabilities) &&
            tab.piBridge.capabilities.includes('pi.models.v1')
        );
    }

    _piBridgeThinkingEligible(tab) {
        return (
            tab?.coder === 'pi' && !tab.isDead &&
            !!tab.ws && tab._piBridgeFresh === tab.ws &&
            tab.piBridge?.state === 'managed' &&
            tab.piBridge.connected === true &&
            Array.isArray(tab.piBridge.capabilities) &&
            tab.piBridge.capabilities.includes('pi.thinking.v1')
        );
    }

    // The skills picker needs the skills capability; anything else
    // keeps the composer exactly as it was, without a dead control.
    _piBridgeSkillsEligible(tab) {
        return piBridgeCapable(tab, 'pi.skills.v1');
    }

    // _piBridgeSkillsContext pins a skills request to the runtime that
    // owns it: the pane and its socket. The answer names the peer that
    // served it, and the browser's generation view only decides
    // staleness: a view that moved on drops the retained rows.
    _piBridgeSkillsContextFor(tab) {
        if (!this._piBridgeSkillsEligible(tab)) return null;
        return {
            paneId: tab.paneId,
            tab,
            socket: tab.ws,
            // The browser's view when the list was asked for.
            seen: tab.piBridge?.generation ?? '',
            origin: null,
        };
    }

    // _piBridgeSkillsContextBound reports whether a skills request
    // still belongs to the tab, socket, and capability it was made
    // for. A replaced tab, a swapped socket, or a revoked capability
    // invalidates the request at once.
    _piBridgeSkillsContextBound(context) {
        return (
            !!context &&
            this.tabs?.get(context.paneId) === context.tab &&
            context.tab.ws === context.socket &&
            this._piBridgeSkillsEligible(context.tab)
        );
    }

    _piBridgeSkillsContextValid(context) {
        if (!this._piBridgeSkillsContextBound(context)) return false;
        const view = context.tab.piBridge?.generation ?? '';
        if (view === context.seen) return true;
        // The view moved on. The rows stay usable only when the answer
        // already belongs to the runtime the browser now sees: the
        // view can lag behind the answer, and a generation counter
        // alone cannot tell one lease from the next.
        return !!context.origin && context.origin.generation === view;
    }

    // _piBridgeSkillsContextStale reports whether a retained skills
    // request must be dropped. A generation view that moved on decides
    // only once the answer landed and named a different runtime: an
    // answer still in flight may belong to the runtime the browser
    // now sees, so it is judged when it arrives.
    _piBridgeSkillsContextStale(context) {
        if (this._piBridgeSkillsContextValid(context)) return false;
        if (
            context?.origin === null &&
            this._piBridgeSkillsContextBound(context)
        )
            return false;
        return true;
    }

    // _piBridgeSkillsOriginMatches reports whether a dispatch and a
    // list belong to the same runtime. The server's answer owns the
    // identity: the browser's generation view can lag behind it, so
    // the view must not decide who owns a pending dispatch.
    _piBridgeSkillsOriginMatches(operation, context) {
        const sent = operation?.origin;
        const listed = context?.origin;
        return (
            !!sent &&
            !!listed &&
            sent.processId === listed.processId &&
            sent.generation === listed.generation
        );
    }

    // _piBridgeSkillsRuntimeCurrent reports whether a started
    // invocation still belongs to the runtime that received it. A
    // swapped socket or a different answering runtime makes the waiter
    // stale; a lost peer does not, because the dispatch may still have
    // landed in the session that is gone.
    _piBridgeSkillsRuntimeCurrent(operation) {
        return (
            !!operation &&
            operation.tab?.ws === operation.socket &&
            this._piBridgeSkillsOriginMatches(
                operation,
                this._piBridgeSkillsContext,
            )
        );
    }

    // _invalidatePiBridgeSkillsList drops the retained skill list and
    // closes the picker. A late reply must not repopulate a picker
    // the user can no longer use. A started invocation keeps its
    // ownership: the dispatch may still have landed, so its bounded
    // reply settles the outcome.
    _invalidatePiBridgeSkillsList() {
        ++this._piBridgeSkillsRequest;
        this._piBridgeSkills = null;
        this._piBridgeSkillsTruncated = false;
        this._piBridgeSkillsUnavailable = false;
        this._piBridgeSkillsStale = false;
        this._piBridgeSkillsContext = null;
        const dropup = document.getElementById('pi-rpc-skills-dropup');
        dropup?.classList.add('hidden');
        dropup?.replaceChildren();
    }

    _piBridgeThinkingContext(tab) {
        if (!this._piBridgeThinkingEligible(tab)) return null;
        // The display model stays the comparison key; provider and model are
        // never split here because either identity may contain '/'.
        const model = tab.piBridge.model || '';
        if (!model) return null;
        return {
            tab,
            paneId: tab.paneId,
            socket: tab.ws,
            generation: tab.piBridge.generation,
            model,
        };
    }

    _piBridgeThinkingContextValid(context) {
        return (
            !!context &&
            this.tabs?.get(context.paneId) === context.tab &&
            this.getActiveTab() === context.tab &&
            context.tab.ws === context.socket &&
            context.tab.piBridge?.generation === context.generation &&
            context.tab.piBridge?.model === context.model &&
            this._piBridgeThinkingEligible(context.tab)
        );
    }

    _piBridgeThinkingOriginMatches(context, result) {
        return (
            this._piBridgeThinkingContextValid(context) &&
            typeof result?.provider === 'string' &&
            result.provider.length > 0 &&
            typeof result?.model === 'string' &&
            result.model.length > 0 &&
            `${result.provider}/${result.model}` === context.model &&
            result?.generation === context.generation &&
            typeof result?.process_id === 'string' &&
            result.process_id.length > 0 &&
            result.unavailable !== true &&
            Array.isArray(result.levels) &&
            result.levels.length > 0 &&
            result.levels.length <= 7 &&
            result.levels.every(
                (level, index) =>
                    PI_BRIDGE_THINKING_LEVELS.includes(level) &&
                    result.levels.indexOf(level) === index,
            )
        );
    }

    async _piBridgeThinkingLevels(paneId) {
        const controller = new AbortController();
        // Short by design: failure falls back to Pi's own /thinking picker,
        // which is local and works offline.
        const timer = setTimeout(() => controller.abort(), 1000);
        try {
            const response = await fetch(
                `/api/pi-bridge/thinking-levels?pane=${encodeURIComponent(paneId)}`,
                { signal: controller.signal },
            );
            if (!response.ok)
                throw new Error(`Pi thinking levels unavailable (${response.status})`);
            return await response.json();
        } catch (error) {
            if (error?.name === 'AbortError')
                throw new Error('Pi thinking levels unavailable (request timed out)');
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    async _piBridgeThinkingSet(context, level, origin) {
        const controller = new AbortController();
        // The menu closes on click; this only bounds the reconciliation.
        const timer = setTimeout(() => controller.abort(), 15000);
        let result;
        try {
            const response = await fetch('/api/pi-bridge/thinking', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pane: context.paneId,
                    level,
                    provider: origin.provider,
                    model: origin.model,
                    process_id: origin.process_id,
                    generation: origin.generation,
                }),
                signal: controller.signal,
            });
            if (!response.ok) throw new Error('unknown');
            result = await response.json();
        } catch {
            // A lost or truncated reply may still have been applied by Pi.
            throw new Error('unknown — reopen the picker');
        } finally {
            clearTimeout(timer);
        }
        if (result?.ok === true) return;
        if (result?.reason === 'unsupported-level')
            throw new Error('Thinking level is no longer supported');
        if (result?.reason === 'model-changed')
            throw new Error('Model changed — reopen the picker');
        throw new Error('unknown — reopen the picker');
    }

    _forwardNativeThinkingCycle(tab) {
        this._forwardKeyToPty(
            { key: 'Tab', shiftKey: true, isComposing: false, preventDefault() {} },
            tab,
        );
    }

    _cyclePiBridgeThinking(tab) {
        if (this._piRpcThinkingPending?.paneId === tab?.paneId) return;
        const context = this._piBridgeThinkingContext(tab);
        if (!context) {
            this._forwardNativeThinkingCycle(tab);
            return;
        }
        const operation = { paneId: tab.paneId, context };
        this._piRpcThinkingPending = operation;
        this._updatePiThinkingButton();
        // An open picker must show the same pending lock as its rows do.
        const thinkingDropup = document.getElementById(
            'pi-rpc-thinking-dropup',
        );
        const syncPickerPending = (disabled) => {
            if (!thinkingDropup || thinkingDropup.classList.contains('hidden'))
                return;
            this._setPiRpcDropupButtonsDisabled(thinkingDropup, disabled);
        };
        syncPickerPending(true);
        Promise.resolve(this._piBridgeThinkingLevels(context.paneId))
            .then((result) => {
                if (
                    this._piRpcThinkingPending !== operation ||
                    !this._piBridgeThinkingContextValid(context)
                )
                    return false;
                if (!this._piBridgeThinkingOriginMatches(context, result))
                    throw new Error('Pi thinking levels unavailable');
                const index = result.levels.indexOf(tab.piBridge.thinking_level);
                if (index < 0) {
                    this._forwardNativeThinkingCycle(tab);
                    return false;
                }
                const level = result.levels[(index + 1) % result.levels.length];
                operation.level = level;
                operation.setterStarted = true;
                return this._piBridgeThinkingSet(context, level, result);
            })
            .then(() => {
                // Ownership first: a superseded cycle owns no state and must
                // never fall back to native input.
                if (this._piRpcThinkingPending !== operation) return;
                this._piRpcThinkingPending = null;
                syncPickerPending(false);
                if (this._piBridgeThinkingContextValid(context))
                    this._updatePiThinkingButton();
            })
            .catch((error) => {
                if (this._piRpcThinkingPending !== operation) return;
                this._piRpcThinkingPending = null;
                syncPickerPending(false);
                if (!this._piBridgeThinkingContextValid(context)) return;
                if (!operation.setterStarted) {
                    this._forwardNativeThinkingCycle(tab);
                } else {
                    this._piRpcError(error, 'Pi thinking');
                }
                this._updatePiThinkingButton();
            });
    }

    _invalidatePiBridgeThinking(tab) {
        if (this._piRpcThinkingPending?.paneId === tab?.paneId)
            this._piRpcThinkingPending = null;
        if (this.getActiveTab() !== tab) return;
        this._piBridgeThinkingMenuRequest =
            (this._piBridgeThinkingMenuRequest || 0) + 1;
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        dropup?.classList.add('hidden');
        dropup?.replaceChildren();
    }

    // Socket changes and bridge views share the same picker invalidation.

    // _piBridgeCapable delegates to the module predicate: point-of-use
    // capability checks stay identical between renders and the
    // ordered-view refresh key.
    _piBridgeCapable(tab, capability) {
        return piBridgeCapable(tab, capability);
    }


    // Point-of-use capability checks read the module predicate
    // directly, so renders and the ordered-view refresh key cannot
    // disagree about a pane's capabilities.
    _piBridgeContextEligible(tab) {
        return piBridgeCapable(tab, 'pi.context.v1');
    }

    _piBridgeCompactEligible(tab) {
        return piBridgeCapable(tab, 'pi.compact.v1');
    }

    // _piBridgeStatusFor adapts bridge context telemetry into the
    // shared status-bar input. Only real cwd/model/tokens/window are
    // carried; RPC totals, cache, cost, and thinking stay unknown.
    _piBridgeStatusFor(tab) {
        const view = tab?.piBridge;
        return {
            cwd: typeof tab?.cwd === 'string' ? tab.cwd : '',
            model: typeof view?.model === 'string' ? view.model : null,
            thinking: null,
            inputTokens: null,
            outputTokens: null,
            contextUsedTokens:
                typeof view?.context_tokens === 'number'
                    ? view.context_tokens
                    : null,
            contextWindowTokens:
                typeof view?.context_window === 'number'
                    ? view.context_window
                    : null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            skills: null,
        };
    }

    // _piBridgeCompactControlState disables the existing /compact
    // controls only for capable Pi PTY tabs: while a native request
    // is pending, while readiness is unknown, or while Pi reports
    // busy/queued/active/pending. Incapable tabs keep legacy buttons.
    _piBridgeCompactControlState(tab) {
        if (!this._piBridgeCompactEligible(tab))
            return { disabled: false, title: '' };
        if (this._piBridgeCompactPending?.get(tab.paneId))
            return { disabled: true, title: 'Compacting…' };
        const { ready, reason } = piBridgeCompactReady(tab.piBridge);
        return { disabled: !ready, title: reason };
    }

    // _piBridgeKeys splits one retained view into the two refresh keys.
    // The row key covers what the presets row renders (Models trigger,
    // slash presets, Compact readiness); the bar key adds the context
    // occupancy only the status-bar meter renders.
    _piBridgeKeys(tab, view = tab.piBridge) {
        if (!view) return { row: '', bar: '' };
        const row = `${this._piBridgeModelsEligible(tab)}|${this._piBridgeThinkingEligible(tab)}|${piBridgeCapable(tab, 'pi.skills.v1')}|${piBridgeCapable(tab, 'pi.context.v1')}|${piBridgeCapable(tab, 'pi.compact.v1')}|${view.state}|${view.generation || ''}|${view.model || ''}|${view.thinking_level || ''}|${view.connected}|${view.running}|${(view.capabilities || []).join(',')}|${view.compact_idle}/${view.compact_queued}/${view.compact_active}/${view.compact_pending}`;
        return {
            row,
            bar: `${row}|${view.context_tokens ?? ''},${view.context_window ?? ''},${view.context_percent ?? ''}`,
        };
    }

    // Socket changes and bridge views share the same row/bar
    // invalidation: the models picker, the context meter, and the
    // Compact controls all re-derive from the retained view.
    _refreshPiBridgeModels(tab) {
        if (tab?.coder !== 'pi') return;
        const eligible = this._piBridgeModelsEligible(tab);
        // Per pane, not through the last-started pointer: another pane's
        // request must not keep this one's dead slot alive.
        if (!eligible && this._piRpcModelInflight?.has(tab.paneId))
            this._dropPiRpcModelInflight(tab.paneId);
        // A pick the user made while the bridge was away goes out now.
        if (eligible) this._flushPiRpcModelNext(tab.paneId);
        // Thinking cleanup first so the single renderPresets below owns the
        // open-picker re-render with settled pending state (one levels fetch).
        this._refreshPiBridgeThinking(tab);
        if (this.getActiveTab() === tab) this.renderPresets('pi');
        if (
            this.getActiveTab() === tab &&
            typeof this.renderPiRpcStatusBar === 'function'
        )
            this.renderPiRpcStatusBar();
    }

    // Cleanup only; the open-picker re-render is owned by renderPresets
    // (via _refreshPiBridgeModels), one levels fetch per frame.
    _refreshPiBridgeThinking(tab) {
        if (tab?.coder !== 'pi') return;
        const pending = this._piRpcThinkingPending;
        if (
            pending?.paneId === tab.paneId &&
            pending.context?.tab === tab &&
            (tab.ws !== pending.context.socket ||
                tab.piBridge?.generation !== pending.context.generation ||
                tab.piBridge?.model !== pending.context.model ||
                !this._piBridgeThinkingEligible(tab))
        )
            this._piRpcThinkingPending = null;
        if (!this._piBridgeThinkingEligible(tab)) {
            this._invalidatePiBridgeThinking(tab);
            // Direct mode returns from renderPresets before its button update,
            // so repaint here or the native fallback stays disabled.
            if (this.getActiveTab() === tab) this._updatePiThinkingButton();
            return;
        }
        if (this.getActiveTab() === tab) this._updatePiThinkingButton();
    }

    // Both replies and fallback keys belong to the original runtime/socket.
    _piRecallContextValid(recall) {
        return (
            this.tabs?.get(recall.paneId) === recall.tab &&
            recall.tab.paneId === recall.paneId && !recall.tab.isDead &&
            recall.tab.ws === recall.socket &&
            recall.tab.piBridge?.generation === recall.gen
        );
    }

    _piRecallCycleValid(tab) {
        const recall = this._piRecall;
        return (
            !!recall && recall.tab === tab &&
            this._piRecallContextValid(recall) &&
            recall.cache?.[recall.cursor] === this.inputTextArea.value
        );
    }

    _resetPiRecall({ flush = false } = {}) {
        const recall = this._piRecall;
        this._piRecall = null;
        if (!recall?.pending) return;
        clearTimeout(recall.pending.timer);
        recall.pending.controller.abort();
        if (
            flush && recall.pending.deferKey &&
            this._piRecallContextValid(recall)
        ) {
            // No toast on a system fallback, even if the socket just closed.
            recall.socket?.sendInput(
                recall.pending.deferKey === 'ArrowDown' ? '\x1b[B' : '\x1b[A',
            );
        }
    }

    // Empty input defers a PTY arrow; nonempty input keeps native movement.
    async _fetchPiRecall(direction, tab, deferKey) {
        this._resetPiRecall({ flush: true });
        const controller = new AbortController();
        const recall = {
            tab,
            socket: tab.ws,
            paneId: tab.paneId,
            gen: tab.piBridge?.generation,
            cursor: -1,
            preCycleValue: this.inputTextArea.value,
            pending: { controller, deferKey, timer: null },
        };
        this._piRecall = recall;
        const fail = () => {
            if (this._piRecall === recall) this._resetPiRecall({ flush: true });
        };
        // Bound the browser too: an HTTP request can stall before reaching Phi.
        recall.pending.timer = setTimeout(fail, 1000);
        try {
            const res = await fetch(
                `/api/pi-history?pane=${encodeURIComponent(recall.paneId)}`,
                { signal: controller.signal, cache: 'no-store' },
            );
            if (!res.ok) {
                fail();
                return;
            }
            const body = await res.json();
            if (this._piRecall !== recall) return;
            if (
                body?.unavailable || !Array.isArray(body?.entries) ||
                body.entries.length === 0 ||
                !body.entries.every((entry) => typeof entry === 'string') ||
                !this._piRecallContextValid(recall) ||
                this.getActiveTab() !== tab || !this._piRecallEligible(tab) ||
                this.inputTextArea.value !== recall.preCycleValue
            ) {
                fail();
                return;
            }
            clearTimeout(recall.pending.timer);
            const deferred = recall.pending.deferKey;
            recall.pending = undefined;
            recall.cache = body.entries;
            if (!this._cyclePiRecallCached(direction)) {
                // A fresh Down has no cache position to advance from.
                recall.pending = { controller, deferKey: deferred };
                fail();
            }
        } catch {
            fail();
        }
    }

    // _cyclePiRecallCached walks the fetched Pi snapshot. Mirrors
    // _cycleChatHistory's cursor semantics — -1 = free-form draft,
    // non-negative = index into the newest-first cache, the first
    // 'older' saves the draft and 'newer' past 0 restores it — except
    // a full exit clears the snapshot so the next cycle fetches fresh.
    _cyclePiRecallCached(direction) {
        const recall = this._piRecall;
        if (!this.inputTextArea || !recall || !Array.isArray(recall.cache))
            return false;
        if (recall.cache.length === 0) return false;
        if (direction === 'newer' && recall.cursor === -1) return false;
        if (recall.preCycleValue === undefined && recall.cursor === -1) {
            recall.preCycleValue = this.inputTextArea.value;
        }
        if (direction === 'older') {
            recall.cursor = Math.min(
                recall.cursor < 0 ? 0 : recall.cursor + 1,
                recall.cache.length - 1,
            );
        } else if (recall.cursor <= 0) {
            this.inputTextArea.value = recall.preCycleValue || '';
            // Full exit: the next cycle fetches a fresh snapshot.
            this._piRecall = null;
            this._placeCursorAtEnd();
            this.adjustInputHeight();
            return true;
        } else {
            recall.cursor -= 1;
        }
        const entry = recall.cache[recall.cursor];
        if (entry === undefined) return false;
        this.inputTextArea.value = entry;
        this._placeCursorAtEnd();
        this.adjustInputHeight();
        return true;
    }
}

Object.assign(TabManager.prototype, terminalHistoryMethods);
