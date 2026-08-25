const SKILL_RE = /^\/skill(?::|\s)/i;
const TEMPLATE_RE = /^\/template(?:\s|$)/i;
const SLASH_RE = /^\/[a-z][\w-]*(\s|$)/i;
export function dispatchComposer(input, options = {}) {
    const s = input.trim();
    if (SLASH_RE.test(s) && !SKILL_RE.test(s) && !TEMPLATE_RE.test(s)) {
        return {
            kind: 'rejected',
            reason: 'extension commands not allowed in native chat; use a TUI tab',
        };
    }
    const delivery = options.followUp
        ? 'followUp'
        : options.busy
          ? 'steer'
          : 'prompt';
    return { kind: 'queue', message: s, delivery };
}
