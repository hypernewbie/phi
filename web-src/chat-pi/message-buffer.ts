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
    /** Pi's message_end surface markers (see
     * research/2026-08-22-0330-pi-rpc-error-rendering.md). The frontend
     * renders the matching red row / per-tool error text from these
     * fields without re-parsing the wire envelope. */
    stopReason?: string;
    errorMessage?: string;
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
export type RenderDisposition =
    | 'full'
    | 'partial'
    | 'partial-clear'
    | 'live-tool'
    | 'none';

export interface BufferResult {
    messages: readonly InboundMessage[];
    gap: boolean;
    /** True only when this event advanced the authoritative sequence. */
    applied: boolean;
    renderDisposition: RenderDisposition;
    partialKind?: 'text' | 'thinking';
    toolCallId?: string;
    output?: string;
    liveToolCleared?: string;
}

/** Applies a snapshot, then strictly ordered events. A seq gap forces rehydrate. */
export class MessageBuffer {
    private messages: InboundMessage[] = [];
    private lastSeq = 0;
    private gapped = false;
    private role = 'assistant';
    private partial = '';
    private partialThinking = '';
    private liveTools: Map<string, string> = new Map();

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
        this.partialThinking = '';
        this.liveTools = new Map();
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
        const d = ev.data as Record<string, unknown> | null | undefined;
        let disposition: RenderDisposition = 'none';
        let partialKind: BufferResult['partialKind'];
        let toolCallId: string | undefined;
        let output: string | undefined;
        let liveToolCleared: string | undefined;
        switch (ev.evt) {
            case 'messageStart': {
                const hadPartial =
                    this.partial !== '' || this.partialThinking !== '';
                // SAFETY: pi's wire envelope is a free-form JSON object;
                // narrow to a record view so individual field reads type-check.
                const startMsg =
                    d?.message && typeof d.message === 'object'
                        ? (d.message as Record<string, unknown>)
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
                const aRecord =
                    a && typeof a === 'object'
                        ? (a as Record<string, unknown>)
                        : null;
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
                const mRecord =
                    m && typeof m === 'object'
                        ? (m as Record<string, unknown>)
                        : null;
                this.partial = '';
                this.partialThinking = '';
                const settled: InboundMessage = {
                    role: (mRecord?.role as string | undefined) ?? this.role,
                    content: (mRecord?.content as unknown) ?? '',
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

    /** Live thinking partial (assembled from thinking_delta); temporary only. */
    getPartialThinking(): string {
        return this.partialThinking;
    }

    /** Current accumulated output for one live tool call, if any. */
    getLiveToolOutput(id: string): string | undefined {
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

function extractLiveToolOutput(partialResult: unknown): string {
    if (!partialResult || typeof partialResult !== 'object') return '';
    const content = (partialResult as Record<string, unknown>).content;
    if (!Array.isArray(content)) return '';
    return content
        .map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
                const record = item as Record<string, unknown>;
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
    // SAFETY: InboundMessage's nominal fields (role, content, details, ...)
    // are read by name above; this cast widens the structural view only
    // for the optional `isError` envelope probe.
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
