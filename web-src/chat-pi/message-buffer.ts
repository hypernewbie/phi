import { createStructuredTranscript } from './render.js';
import type { StructuredMessage } from './render.js';

export interface InboundMessage {
    role: string;
    content: unknown;
    details?: unknown;
    /** Tool-result envelope fields (rpc.md: ToolResultMessage). */
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    ts?: number;
}

export interface Snapshot {
    lastSeq: number;
    messages: InboundMessage[];
}

export interface StructuredMessageSource {
    readonly length: number;
    slice(start: number, end?: number): readonly StructuredMessage[];
}

/** Pair record returned by MessageBuffer.getToolResultMap. */
export interface ToolResultEntry {
    message: InboundMessage;
    isError: boolean;
}

/**
 * Render-time disposition for a single applied event. The chat-pi mount
 * path uses this to decide between a full structured repaint, a narrow
 * live-partial update, and a partial-clear (when a stale partial is open
 * and a new turn starts). State events, queue events, stale events, and
 * gap/reset do not repaint on their own.
 */
export type RenderDisposition = 'full' | 'partial' | 'partial-clear' | 'none';

export interface BufferResult {
    messages: readonly InboundMessage[];
    gap: boolean;
    /** True only when this event advanced the authoritative sequence. */
    applied: boolean;
    renderDisposition: RenderDisposition;
}

/** Applies a snapshot, then strictly ordered events. A seq gap forces rehydrate. */
export class MessageBuffer {
    private messages: InboundMessage[] = [];
    private lastSeq = 0;
    private gapped = false;
    private role = 'assistant';
    private partial = '';

    /**
     * Incremental tool-result index. The map is rebuilt on every
     * applySnapshot and updated on the messageEnd branch when the
     * settled message is a toolResult. Rendering can read it cheaply
     * without re-scanning the whole transcript.
     */
    private toolResults: Map<string, ToolResultEntry> = new Map();

    applySnapshot(snap: Snapshot): void {
        this.messages = [...snap.messages];
        this.lastSeq = snap.lastSeq;
        this.gapped = false;
        this.role = 'assistant';
        this.partial = '';
        this.rebuildToolResultIndex();
    }

    applyEvent(ev: {
        seq: number;
        evt?: string;
        data?: unknown;
    }): BufferResult {
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
        const d = ev.data as Record<string, any> | null | undefined;
        let disposition: RenderDisposition = 'none';
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
                const settled: InboundMessage = {
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
    getMessages(): InboundMessage[] {
        return [...this.messages];
    }

    /**
     * Read-only view onto the live backing array. Callers must not
     * mutate the array; use only for length/iteration from render paths.
     */
    getMessageView(): readonly InboundMessage[] {
        return this.messages;
    }

    /** Constant-time length accessor for the hot render path. */
    getMessageCount(): number {
        return this.messages.length;
    }

    /**
     * Lazy, read-only view onto the live transcript as a structured
     * source. The returned source captures the message count at call
     * time and only converts the requested slice when consumed.
     */
    getStructuredTranscript(): StructuredMessageSource {
        return createStructuredTranscript(this.messages);
    }

    getLastSeq(): number {
        return this.lastSeq;
    }

    /** Live streaming partial (assembled from text_delta); empty when settled. */
    getPartial(): string {
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
    getToolResultMap(): ReadonlyMap<string, ToolResultEntry> {
        return this.toolResults;
    }

    /** Rebuild the incremental tool-result index from the live messages array. */
    private rebuildToolResultIndex(): void {
        const next = new Map<string, ToolResultEntry>();
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
export function extractToolCallId(message: InboundMessage): string | undefined {
    if (typeof message.toolCallId === 'string' && message.toolCallId)
        return message.toolCallId;
    const content = message.content;
    if (!content) return undefined;
    if (Array.isArray(content)) {
        for (const item of content) {
            if (item && typeof item === 'object') {
                const id = (item as Record<string, unknown>).toolCallId;
                if (typeof id === 'string') return id;
                const idSnake = (item as Record<string, unknown>).tool_call_id;
                if (typeof idSnake === 'string') return idSnake;
            }
        }
        return undefined;
    }
    if (typeof content === 'object') {
        const id = (content as Record<string, unknown>).toolCallId;
        if (typeof id === 'string') return id;
        const idSnake = (content as Record<string, unknown>).tool_call_id;
        if (typeof idSnake === 'string') return idSnake;
    }
    return undefined;
}

/**
 * Look for an `isError` flag on a toolResult message. Pi's wire format
 * may surface the flag on the message envelope itself, on a content
 * item, or not at all (current phi RPC bridge). Default to false.
 */
function extractIsError(message: InboundMessage): boolean {
    const envelope = message as unknown as Record<string, unknown>;
    if (envelope.isError === true) return true;
    const content = message.content;
    if (Array.isArray(content)) {
        for (const item of content) {
            if (item && typeof item === 'object') {
                const flag = (item as Record<string, unknown>).isError;
                if (flag === true) return true;
            }
        }
    } else if (content && typeof content === 'object') {
        const flag = (content as Record<string, unknown>).isError;
        if (flag === true) return true;
    }
    return false;
}
