const SKILL_RE = /^\/skill(?::|\s)/i;
const TEMPLATE_RE = /^\/template\s/i;
const SLASH_RE = /^\/[a-z][\w-]*(\s|$)/i;
/** Client-side pre-refusal — the only slash gate in P0 (see §10). */
export function dispatchComposer(input) {
    const s = input.trim();
    if (SLASH_RE.test(s) && !SKILL_RE.test(s) && !TEMPLATE_RE.test(s)) {
        return {
            kind: 'rejected',
            reason: 'extension commands not allowed in native chat; use a TUI tab',
        };
    }
    // Always steer: pi consults streamingBehavior only while streaming, and
    // phi's busy flag lags pi's agent_start by one event — an unconditional
    // steer closes the back-to-back send race and is ignored when idle.
    return {
        kind: 'prompt',
        op: 'prompt',
        message: s,
        streamingBehavior: 'steer',
    };
}
