import { createStructuredTranscript } from './render.js';
/** Applies a snapshot, then strictly ordered events. A seq gap forces rehydrate. */
export class MessageBuffer {
    messages = [];
    lastSeq = 0;
    gapped = false;
    role = 'assistant';
    partial = '';
    partialThinking = '';
    liveTools = new Map();
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
        this.partialThinking = '';
        this.liveTools = new Map();
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
        let partialKind;
        let toolCallId;
        let output;
        let liveToolCleared;
        switch (ev.evt) {
            case 'messageStart': {
                const hadPartial =
                    this.partial !== '' || this.partialThinking !== '';
                // SAFETY: pi's wire envelope is a free-form JSON object;
                // narrow to a record view so individual field reads type-check.
                const startMsg =
                    d?.message && typeof d.message === 'object'
                        ? d.message
                        : null;
                this.role =
                    typeof startMsg?.role === 'string'
                        ? startMsg.role
                        : 'assistant';
                this.partial = '';
                this.partialThinking = '';
                disposition = hadPartial ? 'partial-clear' : 'none';
                break;
            }
            case 'messageUpdate': {
                // pi wire shape: {assistantMessageEvent: {type, contentIndex, delta}}.
                const a = d?.assistantMessageEvent;
                // SAFETY: pi's wire envelope is a free-form JSON object;
                // narrow to a record view so individual field reads type-check.
                const aRecord = a && typeof a === 'object' ? a : null;
                if (
                    aRecord?.type === 'thinking_delta' &&
                    typeof aRecord.delta === 'string'
                ) {
                    this.partialThinking += aRecord.delta;
                    disposition = 'partial';
                    partialKind = 'thinking';
                } else if (
                    aRecord?.type === 'text_delta' &&
                    typeof aRecord.delta === 'string'
                ) {
                    this.partial += aRecord.delta;
                    disposition = 'partial';
                    partialKind = 'text';
                }
                break;
            }
            case 'toolExecutionUpdate': {
                toolCallId =
                    typeof d?.toolCallId === 'string' ? d.toolCallId : '';
                if (!toolCallId) break;
                output = extractLiveToolOutput(d?.partialResult);
                this.liveTools.set(toolCallId, output);
                disposition = 'live-tool';
                break;
            }
            case 'messageEnd': {
                // Authoritative (rpc.md): message_end.message replaces all assembly.
                // Tool-result envelopes carry toolCallId/toolName/isError at the
                // top level — keep them so the view can pair call and result.
                const m = d?.message;
                // SAFETY: pi's wire envelope is a free-form JSON object;
                // narrow to a record view so individual field reads type-check.
                const mRecord = m && typeof m === 'object' ? m : null;
                this.partial = '';
                this.partialThinking = '';
                const settled = {
                    role: mRecord?.role ?? this.role,
                    content: mRecord?.content ?? '',
                };
                if (
                    typeof mRecord?.toolCallId === 'string' &&
                    mRecord.toolCallId
                )
                    settled.toolCallId = mRecord.toolCallId;
                if (typeof mRecord?.toolName === 'string' && mRecord.toolName)
                    settled.toolName = mRecord.toolName;
                if (mRecord?.isError === true) settled.isError = true;
                if (mRecord && Object.hasOwn(mRecord, 'details'))
                    settled.details = mRecord.details;
                if (
                    typeof mRecord?.stopReason === 'string' &&
                    mRecord.stopReason
                )
                    settled.stopReason = mRecord.stopReason;
                if (
                    typeof mRecord?.errorMessage === 'string' &&
                    mRecord.errorMessage
                )
                    settled.errorMessage = mRecord.errorMessage;
                this.messages.push(settled);
                if (settled.role === 'toolResult') {
                    const id = extractToolCallId(settled);
                    if (typeof id === 'string' && id) {
                        this.toolResults.set(id, {
                            message: settled,
                            isError: extractIsError(settled),
                        });
                        if (this.liveTools.delete(id)) liveToolCleared = id;
                    }
                }
                disposition = 'full';
                break;
            }
            case 'transcriptReset': {
                this.gapped = true; // force rehydrate; snapshot replaces transcript
                this.partial = '';
                this.partialThinking = '';
                this.liveTools = new Map();
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
            ...(partialKind ? { partialKind } : {}),
            ...(toolCallId ? { toolCallId, output } : {}),
            ...(liveToolCleared ? { liveToolCleared } : {}),
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
    /** Live thinking partial (assembled from thinking_delta); temporary only. */
    getPartialThinking() {
        return this.partialThinking;
    }
    /** Current accumulated output for one live tool call, if any. */
    getLiveToolOutput(id) {
        return this.liveTools.get(id);
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
function extractLiveToolOutput(partialResult) {
    if (!partialResult || typeof partialResult !== 'object') return '';
    const content = partialResult.content;
    if (!Array.isArray(content)) return '';
    return content
        .map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
                const record = item;
                if (record.type !== 'text') return '';
                const text = record.text;
                if (typeof text === 'string') return text;
            }
            return '';
        })
        .join('');
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
    // SAFETY: InboundMessage's nominal fields (role, content, details, ...)
    // are read by name above; this cast widens the structural view only
    // for the optional `isError` envelope probe.
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
