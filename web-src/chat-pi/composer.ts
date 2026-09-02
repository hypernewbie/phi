export type Dispatch =
    | {
          kind: 'prompt' | 'raw';
          op: 'prompt';
          message: string;
          streamingBehavior?: 'steer';
      }
    | { kind: 'rejected'; reason: string };

export function dispatchComposer(input: string): Dispatch {
    const s = input.trim();
    // TUI commands must reach Pi verbatim. Do not add steer semantics: a
    // slash-prefixed prompt is a command, not an agent turn.
    if (s.startsWith('/')) {
        return { kind: 'raw', op: 'prompt', message: s };
    }
    // Always steer: pi consults streamingBehavior only while streaming, and
    // phi's busy flag lags pi's agent_start by one event — an unconditional
    // steer closes the back-to-back send race and is ignored when idle.
    return {
        kind: 'prompt',
        op: 'prompt',
        message: s,
        streamingBehavior: 'steer' as const,
    };
}
