import { extractToolCallId } from './message-buffer.js';
const compactNumber = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
});
function valueOrDash(value) {
    return value || '—';
}
function numberOrDash(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? compactNumber.format(value)
        : '—';
}
function costOrDash(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const formatted = value.toFixed(2).replace(/\.?(0+)$/u, '');
    return `$${formatted}`;
}
export function formatPiRpcStatus(status) {
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
export function renderHeader(h) {
    return [
        `title: ${h.title}`,
        `cwd: ${h.cwd}`,
        `model: ${h.model || '—'}  thinking: ${h.thinking || '—'}`,
        `status: ${h.status}${h.busy ? ' (busy)' : ''}  queue: ${h.queueDepth}`,
    ].join('\n');
}
/** Convert one raw inbound message into its structured segments. */
export function convertMessage(role, content, fallback) {
    return segmentsFromContent(role, content, fallback);
}
/**
 * Build a lazy view over the supplied raw messages. The returned length
 * is captured at construction time, and `slice()` only converts the
 * requested range. Conversion outside the requested slice does not
 * happen.
 */
export function createStructuredTranscript(messages) {
    const capturedLength = messages.length;
    const raw = messages;
    return {
        get length() {
            return capturedLength;
        },
        slice(start, end) {
            const safeStart = normalizeSliceIndex(start, capturedLength);
            const safeEnd = normalizeSliceIndex(
                end ?? capturedLength,
                capturedLength,
            );
            const out = [];
            for (let i = safeStart; i < safeEnd; i++) {
                out.push(convertSingle(raw[i]));
            }
            return out;
        },
    };
}
function normalizeSliceIndex(value, length) {
    const integer = Number.isNaN(value)
        ? 0
        : value === Infinity || value === -Infinity
          ? value
          : Math.trunc(value);
    if (integer === -Infinity) return 0;
    if (integer < 0) return Math.max(length + integer, 0);
    return Math.min(integer, length);
}
function convertSingle(m) {
    const role =
        m.role === 'user'
            ? 'user'
            : m.role === 'toolResult'
              ? 'toolResult'
              : 'assistant';
    const structured = {
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
/** Coerce Pi's wire-shape `arguments` (JSON string or object) to a plain object. */
function coerceArgs(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                return parsed;
            }
        } catch {
            /* fall through */
        }
    }
    return {};
}
function unsupportedContentLabel(item) {
    if (typeof item.type === 'string' && item.type) return item.type;
    return 'unknown content';
}
function asPiContentItem(value) {
    return value && typeof value === 'object' ? value : {};
}
function walkContentItems(content) {
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
export function renderedUserText(content) {
    return segmentsFromContent('user', content, '')
        .filter((segment) => segment.kind === 'text')
        .map((segment) => segment.text)
        .join('');
}
function segmentsFromContent(role, content, fallback) {
    const items = walkContentItems(content);
    const segments = [];
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
export function renderTranscriptStructured(messages) {
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
export function assistantErrorText(m) {
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
export function renderTranscriptFlat(messages) {
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
function renderContent(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
        return c
            .map((p) =>
                typeof p === 'string'
                    ? p
                    : p && typeof p === 'object' && 'text' in p
                      ? String(p.text)
                      : JSON.stringify(p),
            )
            .join('');
    }
    if (c && typeof c === 'object') {
        const o = c;
        if (typeof o.text === 'string') return o.text;
    }
    return JSON.stringify(c);
}
