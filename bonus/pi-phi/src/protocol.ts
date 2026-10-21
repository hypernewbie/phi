// Canonical bridge constants. Mirrors internal/pibridge/limits.go.
// Change only through a reviewed plan revision when acceptance changes.

export const PROTOCOL_VERSION = 1;

export const CAPABILITY_LIFECYCLE = 'pi.lifecycle.v1';

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

const SUPPORTED = new Set([CAPABILITY_LIFECYCLE]);

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
