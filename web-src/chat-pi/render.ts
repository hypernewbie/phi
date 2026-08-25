import type {
    InboundMessage,
    StructuredMessageSource,
} from './message-buffer.js';
import { extractToolCallId } from './message-buffer.js';

export interface PiRpcStatus {
    cwd: string;
    model?: string | null;
    thinking?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    contextUsedTokens?: number | null;
    contextWindowTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    cost?: number | null;
    skills?: string[] | null;
}

export interface PiRpcStatusDisplay {
    cwd: string;
    model: string;
    thinking: string;
    input: string;
    output: string;
    context: string;
    cacheRead: string;
    cacheWrite: string;
    cost: string;
    skills: string;
}

const compactNumber = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
});

function valueOrDash(value: string | null | undefined): string {
    return value || '—';
}

function numberOrDash(value: number | null | undefined): string {
    return typeof value === 'number' && Number.isFinite(value)
        ? compactNumber.format(value)
        : '—';
}

function costOrDash(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const formatted = value.toFixed(2).replace(/\.?(0+)$/u, '');
    return `$${formatted}`;
}

export function formatPiRpcStatus(
    status: PiRpcStatus | null | undefined,
): PiRpcStatusDisplay {
    return {
        cwd: valueOrDash(status?.cwd),
        model: valueOrDash(status?.model),
        thinking: valueOrDash(status?.thinking),
        input: numberOrDash(status?.inputTokens),
        output: numberOrDash(status?.outputTokens),
        context:
            numberOrDash(status?.contextUsedTokens) === '—' &&
            numberOrDash(status?.contextWindowTokens) === '—'
                ? '—'
                : `${numberOrDash(status?.contextUsedTokens)} / ${numberOrDash(status?.contextWindowTokens)}`,
        cacheRead: numberOrDash(status?.cacheReadTokens),
        cacheWrite: numberOrDash(status?.cacheWriteTokens),
        cost: costOrDash(status?.cost),
        skills:
            status?.skills == null
                ? '—'
                : status.skills.length === 0
                  ? 'none'
                  : status.skills.join(', '),
    };
}

export interface ChatHeader {
    sid: string;
    title: string;
    cwd: string;
    model: string;
    thinking: string;
    busy: boolean;
    status: string;
    queueDepth: number;
}

export function renderHeader(h: ChatHeader): string {
    return [
        `title: ${h.title}`,
        `cwd: ${h.cwd}`,
        `model: ${h.model || '—'}  thinking: ${h.thinking || '—'}`,
        `status: ${h.status}${h.busy ? ' (busy)' : ''}  queue: ${h.queueDepth}`,
    ].join('\n');
}

// ─── Structured transcript (Pi TUI style) ─────────────────────────────

export type Segment =
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; text: string }
    | {
          kind: 'toolCall';
          id: string;
          name: string;
          args: Record<string, unknown>;
      }
    | { kind: 'toolResult'; toolCallId: string; content: string }
    | { kind: 'unsupported'; label: string };

export interface StructuredMessage {
    role: 'user' | 'assistant' | 'toolResult';
    segments: Segment[];
    /** Envelope toolCallId for toolResult messages; lets the view skip
     * results whose output is already rendered inline at the call site. */
    toolCallId?: string;
    /** Pi's message_end markers (see
     * research/2026-08-22-0330-pi-rpc-error-rendering.md). The view
     * renders the matching red row / per-tool error text from these. */
    stopReason?: string;
    errorMessage?: string;
}

/** Convert one raw inbound message into its structured segments. */
export function convertMessage(
    role: 'user' | 'assistant' | 'toolResult',
    content: unknown,
    fallback: string,
): Segment[] {
    return segmentsFromContent(role, content, fallback);
}

/**
 * Build a lazy view over the supplied raw messages. The returned length
 * is captured at construction time, and `slice()` only converts the
 * requested range. Conversion outside the requested slice does not
 * happen.
 */
export function createStructuredTranscript(
    messages: readonly InboundMessage[],
): StructuredMessageSource {
    const capturedLength = messages.length;
    const raw = messages;
    return {
        get length(): number {
            return capturedLength;
        },
        slice(start: number, end?: number): readonly StructuredMessage[] {
            const safeStart = normalizeSliceIndex(start, capturedLength);
            const safeEnd = normalizeSliceIndex(
                end ?? capturedLength,
                capturedLength,
            );
            const out: StructuredMessage[] = [];
            for (let i = safeStart; i < safeEnd; i++) {
                out.push(convertSingle(raw[i]));
            }
            return out;
        },
    };
}

function normalizeSliceIndex(value: number, length: number): number {
    const integer = Number.isNaN(value)
        ? 0
        : value === Infinity || value === -Infinity
          ? value
          : Math.trunc(value);
    if (integer === -Infinity) return 0;
    if (integer < 0) return Math.max(length + integer, 0);
    return Math.min(integer, length);
}

function convertSingle(m: InboundMessage): StructuredMessage {
    const role: StructuredMessage['role'] =
        m.role === 'user'
            ? 'user'
            : m.role === 'toolResult'
              ? 'toolResult'
              : 'assistant';
    const structured: StructuredMessage = {
        role,
        segments: convertMessage(role, m.content, ''),
        ...(role === 'toolResult' ? { toolCallId: extractToolCallId(m) } : {}),
        ...(typeof m.stopReason === 'string' && m.stopReason
            ? { stopReason: m.stopReason }
            : {}),
        ...(typeof m.errorMessage === 'string' && m.errorMessage
            ? { errorMessage: m.errorMessage }
            : {}),
    };
    return structured;
}

interface PiContentItem {
    type?: unknown;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    arguments?: unknown;
    toolCallId?: string;
    tool_call_id?: string;
}

/** Coerce Pi's wire-shape `arguments` (JSON string or object) to a plain object. */
function coerceArgs(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                return parsed as Record<string, unknown>;
            }
        } catch {
            /* fall through */
        }
    }
    return {};
}

function unsupportedContentLabel(item: PiContentItem): string {
    if (typeof item.type === 'string' && item.type) return item.type;
    return 'unknown content';
}

function asPiContentItem(value: unknown): PiContentItem {
    return value && typeof value === 'object' ? (value as PiContentItem) : {};
}

function walkContentItems(content: unknown): PiContentItem[] {
    if (Array.isArray(content)) return content.map(asPiContentItem);
    if (content && typeof content === 'object') {
        return [asPiContentItem(content)];
    }
    if (typeof content === 'string') {
        // Try to parse JSON-encoded structured content first.
        try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) return parsed.map(asPiContentItem);
            if (parsed && typeof parsed === 'object') {
                return [asPiContentItem(parsed)];
            }
        } catch {
            /* not JSON */
        }
        return [{ type: 'text', text: content }];
    }
    return [];
}

export function renderedUserText(content: unknown): string {
    return segmentsFromContent('user', content, '')
        .filter(
            (segment): segment is { kind: 'text'; text: string } =>
                segment.kind === 'text',
        )
        .map((segment) => segment.text)
        .join('');
}

function segmentsFromContent(
    role: 'user' | 'assistant' | 'toolResult',
    content: unknown,
    fallback: string,
): Segment[] {
    const items = walkContentItems(content);
    const segments: Segment[] = [];
    for (const item of items) {
        switch (item.type) {
            case 'text':
                if (typeof item.text === 'string' && item.text) {
                    segments.push({ kind: 'text', text: item.text });
                }
                break;
            case 'thinking':
                if (typeof item.thinking === 'string' && item.thinking) {
                    segments.push({
                        kind: 'thinking',
                        text: item.thinking,
                    });
                }
                break;
            case 'toolCall':
            case 'tool_use': {
                if (
                    typeof item.id === 'string' &&
                    typeof item.name === 'string'
                ) {
                    segments.push({
                        kind: 'toolCall',
                        id: item.id,
                        name: item.name,
                        args: coerceArgs(item.arguments),
                    });
                } else {
                    segments.push({
                        kind: 'unsupported',
                        label: unsupportedContentLabel(item),
                    });
                }
                break;
            }
            default:
                segments.push({
                    kind: 'unsupported',
                    label: unsupportedContentLabel(item),
                });
                break;
        }
    }
    if (segments.length === 0 && fallback) {
        segments.push({ kind: 'text', text: fallback });
    }
    void role;
    return segments;
}

/**
 * Walk a snapshot of inbound messages and emit per-message structured
 * segments. User-role messages wrap a single text segment. Tool-result
 * messages flatten their content array's text items into a single text
 * segment (the `toolCallId` is captured separately by
 * MessageBuffer.getToolResultMap). Assistant messages emit all
 * structured items in array order.
 */
export function renderTranscriptStructured(
    messages: readonly InboundMessage[],
): StructuredMessage[] {
    const source = createStructuredTranscript(messages);
    return [...source.slice(0, source.length)];
}

/**
 * Map an assistant message's stopReason/errorMessage to the user-visible
 * text the view appends after the partial content. Returns null when no
 * error row is required (e.g. tool calls with pending results take
 * per-tool propagation instead, and a clean stopReason="stop" / "end_turn"
 * is not a contract row).
 *
 * Reference parity: dist/modes/interactive/interactive-mode.js:2608–2660
 * (pi's TUI). The raw "Request was aborted" string is the upstream
 * sentinel produced by the abort path; phi renders it as "Operation
 * aborted" so the message reads as completed-cancellation, not a
 * provider-side request.
 */
export function assistantErrorText(m: {
    stopReason?: string;
    errorMessage?: string;
}): string | null {
    const stopReason = m.stopReason ?? '';
    if (stopReason === 'error') {
        return `Error: ${m.errorMessage || 'Unknown error'}`;
    }
    if (stopReason === 'aborted') {
        if (typeof m.errorMessage === 'string' && m.errorMessage) {
            // Pi's abort path emits the sentinel "Request was aborted";
            // render it as "Operation aborted" so the row reads as a
            // user-initiated cancel, not a provider-side failure.
            if (m.errorMessage === 'Request was aborted')
                return 'Operation aborted';
            return m.errorMessage;
        }
        return 'Operation aborted';
    }
    if (stopReason === 'length') {
        return 'Response was truncated before completion.';
    }
    return null;
}

// ─── Legacy flat transcript (kept for non-chat-pi consumers) ──────────

/**
 * Flat transcript string used by callers outside chat-pi (e.g. terminal
 * tests that just want `[role] text…`). chat-pi itself uses
 * `renderTranscriptStructured`.
 */
export function renderTranscriptFlat(messages: InboundMessage[]): string {
    return messages
        .map((m) => `[${m.role}] ${renderContent(m.content)}`)
        .join('\n');
}

/**
 * @deprecated Prefer `renderTranscriptFlat` (renamed) or
 * `renderTranscriptStructured` (new). Kept as an alias for backwards
 * compatibility with code that still imports the old name.
 */
export const renderTranscript = renderTranscriptFlat;

function renderContent(c: unknown): string {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
        return c
            .map((p) =>
                typeof p === 'string'
                    ? p
                    : p && typeof p === 'object' && 'text' in p
                      ? String((p as { text: unknown }).text)
                      : JSON.stringify(p),
            )
            .join('');
    }
    if (c && typeof c === 'object') {
        const o = c as Record<string, unknown>;
        if (typeof o.text === 'string') return o.text;
    }
    return JSON.stringify(c);
}
