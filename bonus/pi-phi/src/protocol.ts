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
export const CAPABILITY_CONTEXT = 'pi.context.v1';
export const CAPABILITY_COMPACT = 'pi.compact.v1';
export const CAPABILITY_RELOAD = 'pi.reload.v1';
export const CAPABILITY_SKILLS = 'pi.skills.v1';
export const CAPABILITY_SYNCBOARD = 'pi.syncboard.v1';
/** Bounds and deadlines for native Syncboard calls. */
export const MAX_SYNCBOARD_VALUE_BYTES = 64 * 1024;
export const MAX_SYNCBOARD_RESPONSE_BYTES = 192 * 1024;
export const MAX_SYNCBOARD_PENDING = 4;
export const SYNCBOARD_CALL_TIMEOUT_MS = 15_000;
export const CAPABILITY_TRANSCRIPT_SEARCH = 'pi.transcript-search.v1';
/** Cap on skill entries per SkillsResponse; excess sets truncated. */
export const MAX_SKILL_ENTRIES = 200;
/**
 * Wire bounds for one skill entry, in UTF-8 bytes. Pi validates
 * character counts and only warns, so a loaded skill can still be
 * unrepresentable here; such a list answers unavailable.
 */
export const MAX_SKILL_NAME_BYTES = 64;
export const MAX_SKILL_DESCRIPTION_BYTES = 1024;
/**
 * True when a skill name is one whitespace-free token. Pi addresses a
 * skill with "/skill:<name>" and splits that name at the first space,
 * so a name with whitespace would expand a different skill. Mirrors
 * isAddressableSkillName in internal/pibridge/skills.go.
 */
export function isAddressableSkillName(name: string): boolean {
    return name !== '' && !/\s/.test(name);
}
/** Max chars of a Compact expected session/leaf/model identity. */
export const MAX_COMPACT_IDENTITY_CHARS = 256;
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
/** Shutdown waits this long for queued settlement edges to flush before closing. */
export const SHUTDOWN_DRAIN_MS = 500;
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
    CAPABILITY_CONTEXT,
    CAPABILITY_COMPACT,
    CAPABILITY_RELOAD,
    CAPABILITY_SKILLS,
    CAPABILITY_SYNCBOARD,
    CAPABILITY_TRANSCRIPT_SEARCH,
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
