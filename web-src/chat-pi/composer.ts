export type Dispatch =
    | {
          kind: 'prompt';
          op: 'prompt';
          message: string;
          streamingBehavior?: 'steer';
      }
    | { kind: 'rejected'; reason: string };

const SKILL_RE = /^\/skill(?::|\s)/i;
const TEMPLATE_RE = /^\/template\s/i;
const SLASH_RE = /^\/[a-z][\w-]*(\s|$)/i;

/** Client-side pre-refusal — the only slash gate in P0 (see §10). */
export function dispatchComposer(input: string, busy: boolean): Dispatch {
    const s = input.trim();
    if (SLASH_RE.test(s) && !SKILL_RE.test(s) && !TEMPLATE_RE.test(s)) {
        return {
            kind: 'rejected',
            reason: 'extension commands not allowed in native chat; use a TUI tab',
        };
    }
    return {
        kind: 'prompt',
        op: 'prompt',
        message: s,
        ...(busy ? { streamingBehavior: 'steer' as const } : {}),
    };
}
