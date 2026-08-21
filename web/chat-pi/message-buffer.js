import { createStructuredTranscript } from './render.js';
/** Applies a snapshot, then strictly ordered events. A seq gap forces rehydrate. */
export class MessageBuffer {
    messages = [];
    lastSeq = 0;
    gapped = false;
    role = 'assistant';
    partial = '';
    /**
     * Incremental tool-result index. The map is rebuilt on every
     * applySnapshot and updated on the messageEnd branch when the
     * settled message is a toolResult. Rendering can read it cheaply
     * without re-scanning the whole transcript.
     */
    toolResults = new Map();
    applySnapshot(snap) {
        this.messages = [...snap.messages];
        this.lastSeq = snap.lastSeq;
        this.gapped = false;
        this.role = 'assistant';
        this.partial = '';
        this.rebuildToolResultIndex();
    }
    applyEvent(ev) {
        if (this.gapped)
            return {
                messages: this.messages,
                gap: true,
                applied: false,
                renderDisposition: 'none',
            };
        if (ev.seq <= this.lastSeq)
            return {
                messages: this.messages,
                gap: false,
                applied: false,
                renderDisposition: 'none',
            };
        if (ev.seq !== this.lastSeq + 1) {
            this.gapped = true;
            return {
                messages: this.messages,
                gap: true,
                applied: false,
                renderDisposition: 'none',
            };
        }
        this.lastSeq = ev.seq;
        const d = ev.data;
        let disposition = 'none';
        switch (ev.evt) {
            case 'messageStart': {
                const hadPartial = this.partial !== '';
                this.role = d?.message?.role ?? 'assistant';
                this.partial = '';
                disposition = hadPartial ? 'partial-clear' : 'none';
                break;
            }
            case 'messageUpdate': {
                // pi wire shape: {assistantMessageEvent: {type, contentIndex, delta}}.
                const a = d?.assistantMessageEvent;
                if (a?.type === 'text_delta' && typeof a.delta === 'string') {
                    this.partial += a.delta;
                    disposition = 'partial';
                }
                break;
            }
            case 'messageEnd': {
                // Authoritative (rpc.md): message_end.message replaces all assembly.
                // Tool-result envelopes carry toolCallId/toolName/isError at the
                // top level — keep them so the view can pair call and result.
                const m = d?.message;
                this.partial = '';
                const settled = {
                    role: m?.role ?? this.role,
                    content: m?.content ?? '',
                };
                if (typeof m?.toolCallId === 'string' && m.toolCallId)
                    settled.toolCallId = m.toolCallId;
                if (typeof m?.toolName === 'string' && m.toolName)
                    settled.toolName = m.toolName;
                if (m?.isError === true) settled.isError = true;
                if (m && typeof m === 'object' && Object.hasOwn(m, 'details'))
                    settled.details = m.details;
                this.messages.push(settled);
                if (settled.role === 'toolResult') {
                    const id = extractToolCallId(settled);
                    if (typeof id === 'string' && id) {
                        this.toolResults.set(id, {
                            message: settled,
                            isError: extractIsError(settled),
                        });
                    }
                }
                disposition = 'full';
                break;
            }
            case 'transcriptReset': {
                this.gapped = true; // force rehydrate; snapshot replaces transcript
                this.toolResults = new Map();
                return {
                    messages: this.messages,
                    gap: true,
                    applied: true,
                    renderDisposition: 'none',
                };
            }
            default:
                break; // stateChanged etc. don't touch the transcript
        }
        return {
            messages: this.messages,
            gap: false,
            applied: true,
            renderDisposition: disposition,
        };
    }
    /** Defensive shallow copy for persistence and external callers. */
    getMessages() {
        return [...this.messages];
    }
    /**
     * Read-only view onto the live backing array. Callers must not
     * mutate the array; use only for length/iteration from render paths.
     */
    getMessageView() {
        return this.messages;
    }
    /** Constant-time length accessor for the hot render path. */
    getMessageCount() {
        return this.messages.length;
    }
    /**
     * Lazy, read-only view onto the live transcript as a structured
     * source. The returned source captures the message count at call
     * time and only converts the requested slice when consumed.
     */
    getStructuredTranscript() {
        return createStructuredTranscript(this.messages);
    }
    getLastSeq() {
        return this.lastSeq;
    }
    /** Live streaming partial (assembled from text_delta); empty when settled. */
    getPartial() {
        return this.partial;
    }
    /**
     * Index of `role: "toolResult"` messages by their `toolCallId`. The
     * returned view is rebuilt incrementally on snapshot and on each
     * settled toolResult, so callers must not mutate it. Each value
     * carries the raw message plus an `isError` flag sourced from the
     * payload (top-level `isError` on the message, `isError` on any
     * content item, or false if the wire didn't include it).
     */
    getToolResultMap() {
        return this.toolResults;
    }
    /** Rebuild the incremental tool-result index from the live messages array. */
    rebuildToolResultIndex() {
        const next = new Map();
        for (const message of this.messages) {
            if (message.role !== 'toolResult') continue;
            const id = extractToolCallId(message);
            if (typeof id === 'string' && id) {
                next.set(id, {
                    message,
                    isError: extractIsError(message),
                });
            }
        }
        this.toolResults = next;
    }
}
/** Pull `toolCallId` out of a toolResult message (envelope first, then
 * legacy content-item shapes). */
export function extractToolCallId(message) {
    if (typeof message.toolCallId === 'string' && message.toolCallId)
        return message.toolCallId;
    const content = message.content;
    if (!content) return undefined;
    if (Array.isArray(content)) {
        for (const item of content) {
            if (item && typeof item === 'object') {
                const id = item.toolCallId;
                if (typeof id === 'string') return id;
                const idSnake = item.tool_call_id;
                if (typeof idSnake === 'string') return idSnake;
            }
        }
        return undefined;
    }
    if (typeof content === 'object') {
        const id = content.toolCallId;
        if (typeof id === 'string') return id;
        const idSnake = content.tool_call_id;
        if (typeof idSnake === 'string') return idSnake;
    }
    return undefined;
}
/**
 * Look for an `isError` flag on a toolResult message. Pi's wire format
 * may surface the flag on the message envelope itself, on a content
 * item, or not at all (current phi RPC bridge). Default to false.
 */
function extractIsError(message) {
    const envelope = message;
    if (envelope.isError === true) return true;
    const content = message.content;
    if (Array.isArray(content)) {
        for (const item of content) {
            if (item && typeof item === 'object') {
                const flag = item.isError;
                if (flag === true) return true;
            }
        }
    } else if (content && typeof content === 'object') {
        const flag = content.isError;
        if (flag === true) return true;
    }
    return false;
}
