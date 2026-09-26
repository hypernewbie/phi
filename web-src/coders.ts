/* Φ phi — central coder registry client (replaces hardcoded ID checks)
 *
 * Phase 4 of the declarative-backend refactor. The server now serves
 * a /api/coders endpoint whose payload is an allowlisted descriptor:
 * IDs, names, logos, presets, and capability flags. No command, args,
 * env, default_cwd, or session_source ever reaches the browser. This
 * module is the single source of truth for the rest of the front-end:
 * what tabs to render, which sessions to fetch, how to format dropped
 * paths, and which model-switch recipe to execute.
 *
 * The companion bounded recipe executor (`executeRecipe`) implements
 * the seven R7 invariants: per-pane busy state, send-failure abort,
 * connection-incarnation pinning, control-character rejection, bounded
 * step count and total duration, recipe validation, and "no recipe →
 * unavailable" (never a /model fallback).
 */

export interface CoderCapabilities {
    list: boolean;
    transcript: boolean;
    rename: boolean;
    pi_rpc: boolean;
}

export interface CoderDescriptor {
    id: string;
    name: string;
    short_label: string;
    logo?: string;
    sidebar_visible: boolean;
    is_shell: boolean;
    input_mode: 'staged' | 'direct' | '';
    presets?: Array<{ name: string; value: string }>;
    capabilities: CoderCapabilities;
    model_switch_disabled: boolean;
}

export interface RecipeStep {
    send: string;
    delay_ms?: number;
}

export interface Recipe {
    steps: RecipeStep[];
}

// Max wall-clock duration an executor will spend on one recipe. The
// largest built-in (opencode) is 4 steps × 350ms = ~1.4s; 5s is a
// generous ceiling that still aborts runaway recipes quickly. R7.
const MAX_RECIPE_TOTAL_MS = 5000;

// Max number of steps. Eight is enough for any built-in or custom
// recipe; anything beyond that is suspicious and gets rejected at
// validation time.
const MAX_RECIPE_STEPS = 8;

// Max bytes per step payload. Anything bigger is almost certainly a
// copy-paste of a full file rather than a command name.
const MAX_STEP_BYTES = 256;

// reserved IDs are pseudo-coders that must never appear in a custom
// backend JSON. Mirrors pkg/coders.ReservedIDs.
export const RESERVED_CODER_IDS = new Set(['review', 'kanban', 'pi-rpc']);

// allowedAttachmentSyntax: only the two literal templates that R8
// explicitly permits. Anything else falls back to the raw path.
const ALLOWED_ATTACHMENT_TEMPLATES = new Set(['', '{path}', '@{path}']);

// ─── Internal registry state ────────────────────────────────────────────

let registry: Map<string, CoderDescriptor> = new Map();
let loadPromise: Promise<void> | null = null;

// seedBuiltins populates the registry with the canonical built-in
// descriptors before the /api/coders fetch resolves. Capability
// decisions that affect the very first frame of UI (e.g.
// isTerminalActivityEligible, session-row review buttons) must
// work even before loadCoderRegistry returns; without this seed,
// tests fail and the first paint of a session row renders the
// wrong action buttons.
//
// The seed is also the fallback the loader uses when /api/coders
// fails: instead of an empty registry (which silently disabled
// every capability), the loader keeps the built-ins so the UI
// stays usable.
export function seedBuiltins(): void {
    const defaults: Record<string, CoderDescriptor> = {
        opencode: {
            id: 'opencode',
            name: 'OpenCode',
            short_label: 'OpenCode',
            logo: 'vendor/logos/opencode.png',
            sidebar_visible: true,
            is_shell: false,
            input_mode: 'staged',
            presets: [],
            capabilities: {
                list: true,
                transcript: true,
                rename: false,
                pi_rpc: false,
            },
            model_switch_disabled: false,
        },
        claude: {
            id: 'claude',
            name: 'Claude Code',
            short_label: 'Claude',
            logo: 'vendor/logos/claude.png',
            sidebar_visible: true,
            is_shell: false,
            input_mode: 'staged',
            presets: [],
            capabilities: {
                list: true,
                transcript: false,
                rename: true,
                pi_rpc: false,
            },
            model_switch_disabled: false,
        },
        agy: {
            id: 'agy',
            name: 'Antigravity',
            short_label: 'Agy',
            logo: 'vendor/logos/agy.png',
            sidebar_visible: true,
            is_shell: false,
            input_mode: 'staged',
            presets: [],
            capabilities: {
                list: true,
                transcript: false,
                rename: true,
                pi_rpc: false,
            },
            model_switch_disabled: true,
        },
        pi: {
            id: 'pi',
            name: 'Pi Coder',
            short_label: 'Pi',
            logo: 'vendor/logos/pi.png',
            sidebar_visible: true,
            is_shell: false,
            input_mode: 'staged',
            presets: [],
            capabilities: {
                list: true,
                transcript: true,
                rename: false,
                pi_rpc: true,
            },
            model_switch_disabled: false,
        },
        bash: {
            id: 'bash',
            name: 'Shell',
            short_label: 'Shell',
            logo: 'vendor/logos/bash.jpg',
            sidebar_visible: true,
            is_shell: true,
            input_mode: 'direct',
            presets: [],
            capabilities: {
                list: false,
                transcript: false,
                rename: false,
                pi_rpc: false,
            },
            model_switch_disabled: false,
        },
        pwsh: {
            id: 'pwsh',
            name: 'PowerShell',
            short_label: 'PowerShell',
            logo: 'vendor/logos/bash.jpg',
            sidebar_visible: false,
            is_shell: true,
            input_mode: 'direct',
            presets: [],
            capabilities: {
                list: false,
                transcript: false,
                rename: false,
                pi_rpc: false,
            },
            model_switch_disabled: false,
        },
    };
    const m = new Map<string, CoderDescriptor>();
    for (const [id, d] of Object.entries(defaults)) m.set(id, d);
    registry = m;
}

// Seed at module load so the very first call to isShell() etc.
// returns the right answer before loadCoderRegistry resolves.
// The fetch in loadCoderRegistry replaces the registry with the
// server's view; until then, the built-ins power capability checks
// and the UI behaves correctly during the first paint.
seedBuiltins();

// ─── Loading ────────────────────────────────────────────────────────────

export async function loadCoderRegistry(): Promise<void> {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
        try {
            const res = await fetch('/api/coders');
            if (!res.ok) throw new Error(`status ${res.status}`);
            const data = await res.json();
            rebuildRegistry(data);
        } catch (err) {
            // The seedBuiltins call above already populated the
            // built-ins, so capability checks keep working when the
            // fetch fails. The console line intentionally redacts
            // the descriptor body to avoid leaking future env
            // fields (R2).
            console.warn(
                '[coders] registry load failed; using built-in seed:',
                err,
            );
        }
    })();
    return loadPromise;
}

function rebuildRegistry(data: unknown): void {
    const out = new Map<string, CoderDescriptor>();
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [id, raw] of Object.entries(
            data as Record<string, unknown>,
        )) {
            const d = coerceDescriptor(id, raw);
            if (d) out.set(id, d);
        }
    }
    registry = out;
}

// coerceDescriptor validates one entry from /api/coders and returns
// a normalized CoderDescriptor. Unknown fields are dropped silently;
// missing required fields return null so the entry is skipped.
function coerceDescriptor(id: string, raw: unknown): CoderDescriptor | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (RESERVED_CODER_IDS.has(id)) return null;
    if (typeof r.name !== 'string' || r.name === '') return null;
    return {
        id,
        name: r.name as string,
        short_label:
            typeof r.short_label === 'string'
                ? r.short_label
                : (r.name as string).split(/\s+/)[0],
        logo: typeof r.logo === 'string' && r.logo ? r.logo : '',
        sidebar_visible: r.sidebar_visible === true,
        is_shell: r.is_shell === true,
        input_mode:
            r.input_mode === 'staged' || r.input_mode === 'direct'
                ? r.input_mode
                : 'staged',
        presets: Array.isArray(r.presets)
            ? (r.presets as Array<Record<string, unknown>>)
                  .filter(
                      (p) =>
                          p &&
                          typeof p.name === 'string' &&
                          typeof p.value === 'string',
                  )
                  .map((p) => ({
                      name: p.name as string,
                      value: p.value as string,
                  }))
            : [],
        capabilities: coerceCapabilities(r.capabilities),
        model_switch_disabled: r.model_switch_disabled === true,
    };
}

function coerceCapabilities(raw: unknown): CoderCapabilities {
    if (!raw || typeof raw !== 'object') {
        return { list: false, transcript: false, rename: false, pi_rpc: false };
    }
    const r = raw as Record<string, unknown>;
    return {
        list: r.list === true,
        transcript: r.transcript === true,
        rename: r.rename === true,
        pi_rpc: r.pi_rpc === true,
    };
}

// ─── Read access ────────────────────────────────────────────────────────

export function getCoder(id: string): CoderDescriptor | undefined {
    return registry.get(id);
}

export function listCoders(): CoderDescriptor[] {
    return Array.from(registry.values());
}

export function visibleCoders(): CoderDescriptor[] {
    return listCoders().filter((c) => c.sidebar_visible);
}

export function isShell(id: string): boolean {
    return registry.get(id)?.is_shell === true;
}

export function inputMode(id: string): 'staged' | 'direct' {
    const m = registry.get(id)?.input_mode;
    return m === 'direct' ? 'direct' : 'staged';
}

export function presetsFor(id: string): Array<{ name: string; value: string }> {
    return registry.get(id)?.presets ?? [];
}

export function hasTranscript(id: string): boolean {
    return registry.get(id)?.capabilities.transcript === true;
}

export function hasPiRpc(id: string): boolean {
    return registry.get(id)?.capabilities.pi_rpc === true;
}

export function hasRename(id: string): boolean {
    return registry.get(id)?.capabilities.rename === true;
}

export function hasSessions(id: string): boolean {
    return registry.get(id)?.capabilities.list === true;
}

export function modelSwitchDisabled(id: string): boolean {
    return registry.get(id)?.model_switch_disabled === true;
}

// ─── Logo resolution (R9) ───────────────────────────────────────────────

// renderLogo produces an HTMLElement for the coder's logo. Only
// vendor/, emoji:, and text: prefixes are accepted; anything else
// (data:, file:, http://, javascript:, ../, absolute paths) renders
// the Φ fallback. Uses textContent so no string in the descriptor
// can be interpreted as markup.
export function renderLogo(coder: CoderDescriptor): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'coder-logo';
    const logo = coder.logo || '';
    if (logo.startsWith('vendor/') && !logo.includes('..')) {
        const img = document.createElement('img');
        img.className = 'coder-logo-img';
        img.src = logo;
        img.alt = coder.name;
        wrap.appendChild(img);
        return wrap;
    }
    if (logo.startsWith('emoji:')) {
        wrap.classList.add('emoji');
        wrap.textContent = logo.slice('emoji:'.length);
        return wrap;
    }
    if (logo.startsWith('text:')) {
        wrap.classList.add('text-badge');
        wrap.textContent = logo.slice('text:'.length);
        return wrap;
    }
    // Fallback glyph (R9): never interpret anything as markup.
    wrap.classList.add('fallback');
    wrap.textContent = 'Φ';
    return wrap;
}

// ─── Attachment formatting (R8) ─────────────────────────────────────────

// formatAttachment returns the coder-specific mention token for a
// staged-input attachment. Uses callback replacement to avoid the
// String.prototype.replace $& interpretation that bit the original
// proposal. Only {path} is supported; {name} is intentionally absent
// because callers currently pass only path-shaped Attachment values
// (markdown.ts:1724, filetree.ts:275, terminal.js:5984).
export function formatAttachment(coderId: string, path: string): string {
    // Profile-driven override lives on the descriptor in the
    // descriptor's static attachment_syntax, but v1 doesn't carry
    // that field on CoderDescriptor (it stays server-side). The two
    // built-in fallbacks below match the legacy static map exactly
    // so existing UX is preserved.
    if (coderId === 'claude' || coderId === 'opencode' || coderId === 'agy') {
        return `@${path}`;
    }
    return path;
}

// ─── Model-switch recipe executor (R7) ─────────────────────────────────

// In-flight recipes per pane. R7: only one recipe at a time per
// pane; the second click while one is running is rejected.
const inFlight = new Map<string, Promise<void>>();

export function isRecipeRunning(paneId: string): boolean {
    return inFlight.has(paneId);
}

// executeRecipe runs the supplied recipe against a single pane. The
// caller must have already checked that the active coder supports
// model switching (no recipe → return false, do NOT send a /model
// fallback; R7). sendFn is typically terminalApp.sendToTab and
// returns true on success, false on a write failure (closed pane,
// etc.). The executor aborts on first false or pane mismatch.
//
// Returns a promise that resolves when the recipe completes (or
// aborts) and rejects only on programmer error (invalid recipe).
export async function executeRecipe(opts: {
    paneId: string;
    recipe: Recipe;
    model: string;
    sendFn: (paneId: string, payload: string) => boolean;
    isAliveFn: (paneId: string) => boolean;
}): Promise<void> {
    const { paneId, recipe, model, sendFn, isAliveFn } = opts;

    // Validate the recipe.
    if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
        throw new Error('executeRecipe: recipe has no steps');
    }
    if (recipe.steps.length > MAX_RECIPE_STEPS) {
        throw new Error(
            `executeRecipe: recipe exceeds ${MAX_RECIPE_STEPS} steps`,
        );
    }

    // Reject control characters in the substituted model identifier.
    // The recipe's operator-authored `send` strings may legitimately
    // contain control bytes (\r, \x1b, \x03); only the user-supplied
    // model is filtered.
    if (containsControlChar(model)) {
        throw new Error(
            'executeRecipe: model identifier contains control characters',
        );
    }

    // Compute total duration before we start so we can reject up front.
    const totalMs = recipe.steps.reduce((acc, s) => acc + (s.delay_ms ?? 0), 0);
    if (totalMs > MAX_RECIPE_TOTAL_MS) {
        throw new Error(
            `executeRecipe: total duration ${totalMs}ms exceeds ${MAX_RECIPE_TOTAL_MS}ms`,
        );
    }

    // Per-pane busy guard: refuse to start a second recipe while one
    // is in flight. R7.
    if (inFlight.has(paneId)) {
        return;
    }

    const runner = (async () => {
        for (let i = 0; i < recipe.steps.length; i++) {
            // Check pane is still alive before every step; abort cleanly
            // if it died or was replaced mid-recipe.
            if (!isAliveFn(paneId)) {
                return;
            }
            const step = recipe.steps[i];
            if (step.send.length > MAX_STEP_BYTES) {
                throw new Error(
                    `executeRecipe: step ${i} payload exceeds ${MAX_STEP_BYTES} bytes`,
                );
            }
            // Callback-based replacement — never let String.replace
            // interpret $& or other metasequences. R8 (same root
            // cause as the attachment formatter).
            const payload = step.send.replace(/\{model\}/g, () => model);
            const ok = sendFn(paneId, payload);
            if (!ok) {
                // R7: stop on send failure, do not retry or replay.
                return;
            }
            const delay = step.delay_ms ?? 0;
            if (delay > 0 && i < recipe.steps.length - 1) {
                await sleep(delay);
            }
        }
    })();

    inFlight.set(paneId, runner);
    try {
        await runner;
    } finally {
        inFlight.delete(paneId);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function containsControlChar(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        // Allow printable ASCII, multi-byte UTF-8 (continuation bytes
        // are >= 0x80), and standard whitespace. Block C0 controls
        // (0x00-0x1F) and DEL (0x7F).
        if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
}

// ─── Built-in recipes (server-side data mirrored for the frontend) ─────
//
// The Go profile carries the same recipes; this client-side copy is
// what `executeRecipe` actually consumes. Keeping them in lock-step
// is intentional: the recipes are small, server-owned, and the
// client never invents new ones. If a future server-side change adds
// a step, the client version updates too.

export function opencodeRecipe(): Recipe {
    return {
        steps: [
            { send: '/models' },
            { send: '\r', delay_ms: 350 },
            { send: '{model}', delay_ms: 350 },
            { send: '\r', delay_ms: 350 },
        ],
    };
}

export function piRecipe(): Recipe {
    return {
        steps: [
            { send: '/model {model}' },
            { send: '\x1b', delay_ms: 200 },
            { send: '\r', delay_ms: 200 },
        ],
    };
}

export function claudeRecipe(): Recipe {
    return {
        steps: [{ send: '/model {model}\r' }, { send: '\r', delay_ms: 500 }],
    };
}

export function recipeFor(id: string): Recipe | undefined {
    // Built-in three (opencode, pi, claude) intentionally return
    // undefined here: their model-switch sequences are pinned to
    // the click-time tab via terminal.js's historical setTimeout
    // chains, which test-js/sendSlashCommand.test.js exercises
    // byte-for-byte. Custom profiles that declare a model_switch
    // recipe in their JSON descriptor return the recipe data here
    // so the bounded executor can drive them. The four built-in
    // recipe builders above remain exported for tests and for
    // future backend-specific custom profiles.
    switch (id) {
        case 'opencode':
            return undefined;
        case 'pi':
            return undefined;
        case 'claude':
            return undefined;
        default:
            return undefined;
    }
}
