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
    | { kind: 'toolResult'; toolCallId: string; content: string };

export interface StructuredMessage {
    role: 'user' | 'assistant' | 'toolResult';
    segments: Segment[];
    /** Envelope toolCallId for toolResult messages; lets the view skip
     * results whose output is already rendered inline at the call site. */
    toolCallId?: string;
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
    return {
        role,
        segments: convertMessage(role, m.content, ''),
        ...(role === 'toolResult' ? { toolCallId: extractToolCallId(m) } : {}),
    };
}

interface PiContentItem {
    type?: string;
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

function walkContentItems(content: unknown): PiContentItem[] {
    if (Array.isArray(content)) return content as PiContentItem[];
    if (content && typeof content === 'object') {
        return [content as PiContentItem];
    }
    if (typeof content === 'string') {
        // Try to parse JSON-encoded structured content first.
        try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) return parsed as PiContentItem[];
            if (parsed && typeof parsed === 'object') {
                return [parsed as PiContentItem];
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
                }
                break;
            }
            default:
                // Unknown / non-renderable item: drop silently.
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
