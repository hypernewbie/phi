// Canonical bridge constants. Mirrors internal/pibridge/limits.go.
// Change only through a reviewed plan revision when acceptance changes.

export const PROTOCOL_VERSION = 1;

export const CAPABILITY_LIFECYCLE = 'pi.lifecycle.v1';
export const CAPABILITY_HISTORY = 'pi.history.v1';
export const CAPABILITY_MODELS = 'pi.models.v1';
export const CAPABILITY_THINKING = 'pi.thinking.v1';
/** Thinking list and setter bounds shared with the bridge peer. */
export const MAX_THINKING_LEVELS = 7;
export const MAX_THINKING_MODEL_ID_BYTES = 256;
export const MAX_THINKING_LEVEL_BYTES = 16;
/** Cap on catalog entries per ModelsResponse; excess sets truncated. */
export const MAX_MODELS_ENTRIES = 500;
/**
 * Queue bytes history responses must leave free. History shares the
 * bounded queue with lifecycle edges, so a history frame admits only
 * while the queue keeps this much headroom after admission; an
 * admitted frame can then never starve the next lifecycle edge. At
 * several times the largest lifecycle frame (a full-journal
 * snapshot, well under 4 KiB), 16 KiB keeps the bound airtight while
 * leaving history ~240 KiB of the shared queue.
 */
export const LIFECYCLE_HEADROOM_BYTES = 16 * 1024;
export const LIFECYCLE_HEADROOM_MESSAGES = 2;

export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_QUEUED_MESSAGES = 16;
export const MAX_QUEUED_BYTES = 256 * 1024;
export const BLOCKED_SEND_TIMEOUT_MS = 5_000;
export const HELLO_DEADLINE_MS = 5_000;
export const MAX_JOURNAL_RECORDS = 64;
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 30_000;
/** Connection stability that resets reconnect backoff. */
export const RECONNECT_STABLE_MS = 30_000;

export const METADATA_TOKEN_KEY = 'phi-pi-token';
export const METADATA_PANE_KEY = 'phi-pi-pane';
export const METADATA_PROCESS_KEY = 'phi-pi-process';

const SUPPORTED = new Set([
    CAPABILITY_LIFECYCLE,
    CAPABILITY_HISTORY,
    CAPABILITY_MODELS,
    CAPABILITY_THINKING,
]);

/** Intersect advertised names with the supported set. Unknown names are ignored. */
export function negotiateCapabilities(advertised: readonly string[]): string[] {
    const out: string[] = [];
    for (const c of advertised) {
        if (SUPPORTED.has(c) && !out.includes(c)) out.push(c);
    }
    return out;
}

/** True when name is a known bridge capability. */
export function isKnownCapability(name: string): boolean {
    return SUPPORTED.has(name);
}
