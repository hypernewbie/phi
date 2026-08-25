export type QueueDelivery = 'prompt' | 'steer' | 'followUp';

export type Dispatch =
    | {
          kind: 'queue';
          message: string;
          delivery: QueueDelivery;
      }
    | { kind: 'rejected'; reason: string };

const SKILL_RE = /^\/skill(?::|\s)/i;
const TEMPLATE_RE = /^\/template(?:\s|$)/i;
const SLASH_RE = /^\/[a-z][\w-]*(\s|$)/i;

export function dispatchComposer(
    input: string,
    options: { busy?: boolean; followUp?: boolean } = {},
): Dispatch {
    const s = input.trim();
    if (SLASH_RE.test(s) && !SKILL_RE.test(s) && !TEMPLATE_RE.test(s)) {
        return {
            kind: 'rejected',
            reason: 'extension commands not allowed in native chat; use a TUI tab',
        };
    }
    const delivery: QueueDelivery = options.followUp
        ? 'followUp'
        : options.busy
          ? 'steer'
          : 'prompt';
    return { kind: 'queue', message: s, delivery };
}
