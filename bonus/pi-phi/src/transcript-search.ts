// Bounded, read-only search over Pi's public active-branch session API.
// Only visible user/assistant/tool-result text is inspected; private
// thoughts, tool arguments, images, and extension state never leave Pi.

export const MAX_TRANSCRIPT_QUERY_CODE_POINTS = 256;
export const MAX_TRANSCRIPT_QUERY_BYTES = 1024;
export const MAX_TRANSCRIPT_ENTRIES_PER_PAGE = 256;
export const MAX_TRANSCRIPT_MATCHES_PER_PAGE = 50;
export const MAX_TRANSCRIPT_TEXT_CHUNK_BYTES = 32 * 1024;
export const MAX_TRANSCRIPT_SNIPPET_BYTES = 2048;
export const TRANSCRIPT_SEARCH_DEADLINE_MS = 1500;
export const MAX_TRANSCRIPT_CONCURRENT_READS = 2;
const COOPERATIVE_YIELD_MS = 25;
const MAX_IDENTITY_BYTES = 256;

export interface TranscriptSessionManager {
    getSessionId(): string;
    getLeafId(): string | null;
    getBranch(fromId?: string): readonly unknown[];
}

export interface TranscriptSearchInput {
    readonly query: string;
    readonly expectedSessionId: string;
    readonly initial: boolean;
    readonly anchorLeafId: string;
    readonly startIndex: number;
    readonly signal: AbortSignal;
    readonly deadlineAt: number;
}

export interface TranscriptSearchMatch {
    readonly entryId: string;
    readonly role: 'user' | 'assistant' | 'toolResult';
    readonly snippet: string;
}

export interface TranscriptSearchPage {
    readonly sessionId: string;
    readonly anchorLeafId: string;
    readonly nextIndex: number;
    readonly matches: readonly TranscriptSearchMatch[];
    readonly complete: boolean;
    readonly unavailable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Width(codePoint: number): number {
    if (codePoint <= 0x7f) return 1;
    if (codePoint <= 0x7ff) return 2;
    if (codePoint <= 0xffff) return 3;
    return 4;
}

function queryBytes(query: string): number {
    return new TextEncoder().encode(query).byteLength;
}

export function isTranscriptSearchQuery(query: string): boolean {
    return (
        query !== '' &&
        Array.from(query).length <= MAX_TRANSCRIPT_QUERY_CODE_POINTS &&
        queryBytes(query) <= MAX_TRANSCRIPT_QUERY_BYTES
    );
}

export function isTranscriptSearchAvailable(
    value: unknown,
): value is TranscriptSessionManager {
    if (!isRecord(value)) return false;
    try {
        return (
            typeof value.getSessionId === 'function' &&
            typeof value.getLeafId === 'function' &&
            typeof value.getBranch === 'function'
        );
    } catch {
        return false;
    }
}

function validIdentity(value: string): boolean {
    return value !== '' && queryBytes(value) <= MAX_IDENTITY_BYTES;
}

function previousCodePointStart(text: string, end: number): number {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xdc00 && last <= 0xdfff && end > 1) {
        const before = text.charCodeAt(end - 2);
        if (before >= 0xd800 && before <= 0xdbff) return end - 2;
    }
    return end - 1;
}

function nextCodePointEnd(text: string, start: number): number {
    const codePoint = text.codePointAt(start);
    return start + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

function prefixEndByBytes(
    text: string,
    start: number,
    maxBytes: number,
): number {
    let end = start;
    let bytes = 0;
    while (end < text.length) {
        const point = text.codePointAt(end);
        if (point === undefined) break;
        const width = utf8Width(point);
        if (bytes + width > maxBytes) break;
        bytes += width;
        end = nextCodePointEnd(text, end);
    }
    return end;
}

function suffixStartByBytes(
    text: string,
    end: number,
    maxBytes: number,
): number {
    let start = end;
    let bytes = 0;
    while (start > 0) {
        const previous = previousCodePointStart(text, start);
        const point = text.codePointAt(previous);
        if (point === undefined) break;
        const width = utf8Width(point);
        if (bytes + width > maxBytes) break;
        bytes += width;
        start = previous;
    }
    return start;
}

function chunkEndByBytes(
    text: string,
    start: number,
    maxBytes: number,
): number {
    return prefixEndByBytes(text, start, maxBytes);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeSnippet(text: string, start: number, end: number): string | null {
    const matched = text.slice(start, end);
    const matchedBytes = queryBytes(matched);
    if (matchedBytes > MAX_TRANSCRIPT_SNIPPET_BYTES) return null;
    const hasPrefix = start > 0;
    const hasSuffix = end < text.length;
    const ellipsisBytes = (hasPrefix ? 3 : 0) + (hasSuffix ? 3 : 0);
    const contextBytes = Math.max(
        0,
        MAX_TRANSCRIPT_SNIPPET_BYTES - matchedBytes - ellipsisBytes,
    );
    const prefixBudget = Math.floor(contextBytes / 2);
    const suffixBudget = contextBytes - prefixBudget;
    const prefixStart = suffixStartByBytes(text, start, prefixBudget);
    const suffixEnd = prefixEndByBytes(text, end, suffixBudget);
    const snippet =
        (prefixStart > 0 ? '…' : '') +
        text.slice(prefixStart, start) +
        matched +
        text.slice(end, suffixEnd) +
        (suffixEnd < text.length ? '…' : '');
    return queryBytes(snippet) <= MAX_TRANSCRIPT_SNIPPET_BYTES ? snippet : null;
}

async function yieldIfNeeded(lastYieldAt: number): Promise<number> {
    if (Date.now() - lastYieldAt < COOPERATIVE_YIELD_MS) return lastYieldAt;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return Date.now();
}

async function findTextMatch(
    text: string,
    pattern: RegExp,
    queryCodePoints: number,
    input: TranscriptSearchInput,
    lastYieldAt: number,
): Promise<{
    snippet: string | null;
    lastYieldAt: number;
    unavailable: boolean;
}> {
    let offset = 0;
    let yieldedAt = lastYieldAt;
    // Unicode simple folds can use more UTF-8 bytes than the query (k → K).
    const overlapBytes = Math.min(
        queryCodePoints * 4,
        MAX_TRANSCRIPT_TEXT_CHUNK_BYTES - 1,
    );
    const mainChunkBytes = MAX_TRANSCRIPT_TEXT_CHUNK_BYTES - overlapBytes;
    while (offset < text.length) {
        if (input.signal.aborted || Date.now() >= input.deadlineAt) {
            return { snippet: null, lastYieldAt: yieldedAt, unavailable: true };
        }
        const chunkStart = suffixStartByBytes(text, offset, overlapBytes);
        const chunkEnd = chunkEndByBytes(text, offset, mainChunkBytes);
        if (chunkEnd <= offset) {
            return { snippet: null, lastYieldAt: yieldedAt, unavailable: true };
        }
        const chunk = text.slice(chunkStart, chunkEnd);
        pattern.lastIndex = 0;
        while (true) {
            const match = pattern.exec(chunk);
            if (match === null) break;
            const matchStart = chunkStart + match.index;
            const matchEnd = matchStart + match[0].length;
            if (offset === 0 || matchEnd > offset) {
                const snippet = makeSnippet(text, matchStart, matchEnd);
                return {
                    snippet,
                    lastYieldAt: yieldedAt,
                    unavailable: snippet === null,
                };
            }
        }
        offset = chunkEnd;
        // Even one very large message yields once per 32 KiB chunk so
        // cancellation and the deadline remain observable.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yieldedAt = Date.now();
    }
    return { snippet: null, lastYieldAt: yieldedAt, unavailable: false };
}

function readBranch(
    manager: TranscriptSessionManager,
    fromId: string | null,
): readonly Record<string, unknown>[] | null {
    let entries: readonly unknown[];
    try {
        entries = manager.getBranch(fromId ?? undefined);
    } catch {
        return null;
    }
    if (!Array.isArray(entries)) return null;
    const out: Record<string, unknown>[] = [];
    const ids = new Set<string>();
    let parentId: string | null = null;
    for (const item of entries) {
        if (!isRecord(item)) return null;
        const id = item.id;
        if (typeof id !== 'string' || !validIdentity(id) || ids.has(id))
            return null;
        if (item.parentId !== parentId) return null;
        ids.add(id);
        parentId = id;
        out.push(item);
    }
    if (fromId === null) return out.length === 0 ? out : null;
    return out.length > 0 && out[out.length - 1]?.id === fromId ? out : null;
}

function visibleTextSegments(
    message: unknown,
): { role: TranscriptSearchMatch['role']; texts: string[] } | null {
    if (!isRecord(message)) return null;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'toolResult')
        return null;
    const content = message.content;
    if (typeof content === 'string') return { role, texts: [content] };
    if (!Array.isArray(content)) return null;
    const texts: string[] = [];
    for (const part of content) {
        if (
            !isRecord(part) ||
            part.type !== 'text' ||
            typeof part.text !== 'string'
        )
            continue;
        texts.push(part.text);
    }
    return { role, texts };
}

function unavailablePage(
    sessionId: string,
    anchorLeafId: string,
    startIndex: number,
): TranscriptSearchPage {
    return {
        sessionId,
        anchorLeafId,
        nextIndex: startIndex,
        matches: [],
        complete: false,
        unavailable: true,
    };
}

/** Search one bounded page from the active branch. Every failure is unavailable. */
export async function searchTranscriptPage(
    manager: TranscriptSessionManager,
    input: TranscriptSearchInput,
): Promise<TranscriptSearchPage> {
    let sessionId = input.expectedSessionId;
    let anchorLeafId = input.anchorLeafId;
    try {
        if (
            !isTranscriptSearchQuery(input.query) ||
            !validIdentity(input.expectedSessionId) ||
            !Number.isSafeInteger(input.startIndex) ||
            input.startIndex < 0 ||
            input.startIndex > 0xffffffff ||
            input.signal.aborted ||
            Date.now() >= input.deadlineAt ||
            manager.getSessionId() !== input.expectedSessionId
        )
            return unavailablePage(sessionId, anchorLeafId, input.startIndex);

        let branch: readonly Record<string, unknown>[] | null;
        if (input.initial) {
            if (input.startIndex !== 0 || input.anchorLeafId !== '')
                return unavailablePage(sessionId, '', input.startIndex);
            const leafId = manager.getLeafId();
            if (leafId !== null && !validIdentity(leafId))
                return unavailablePage(sessionId, '', input.startIndex);
            anchorLeafId = leafId ?? '';
            branch = readBranch(manager, leafId);
        } else {
            if (
                !validIdentity(input.anchorLeafId) ||
                input.startIndex === 0 ||
                input.startIndex > 0xffffffff
            )
                return unavailablePage(
                    sessionId,
                    anchorLeafId,
                    input.startIndex,
                );
            const currentLeaf = manager.getLeafId();
            const activeBranch = readBranch(manager, currentLeaf);
            if (
                !activeBranch ||
                !activeBranch.some((entry) => entry.id === input.anchorLeafId)
            )
                return unavailablePage(
                    sessionId,
                    anchorLeafId,
                    input.startIndex,
                );
            branch =
                currentLeaf === input.anchorLeafId
                    ? activeBranch
                    : readBranch(manager, input.anchorLeafId);
        }
        if (!branch || input.startIndex > branch.length)
            return unavailablePage(sessionId, anchorLeafId, input.startIndex);

        const pattern = new RegExp(escapeRegExp(input.query), 'giu');
        const queryCodePoints = Array.from(input.query).length;
        const matches: TranscriptSearchMatch[] = [];
        const endIndex = Math.min(
            branch.length,
            input.startIndex + MAX_TRANSCRIPT_ENTRIES_PER_PAGE,
        );
        let lastYieldAt = Date.now();
        let nextIndex = input.startIndex;
        for (let index = input.startIndex; index < endIndex; index++) {
            if (
                input.signal.aborted ||
                Date.now() >= input.deadlineAt ||
                manager.getSessionId() !== input.expectedSessionId
            )
                return unavailablePage(
                    sessionId,
                    anchorLeafId,
                    input.startIndex,
                );
            const entry = branch[index];
            nextIndex = index + 1;
            if (entry?.type === 'message') {
                const message = visibleTextSegments(entry.message);
                if (message) {
                    for (const text of message.texts) {
                        const found = await findTextMatch(
                            text,
                            pattern,
                            queryCodePoints,
                            input,
                            lastYieldAt,
                        );
                        lastYieldAt = found.lastYieldAt;
                        if (found.unavailable)
                            return unavailablePage(
                                sessionId,
                                anchorLeafId,
                                input.startIndex,
                            );
                        if (found.snippet !== null) {
                            matches.push({
                                entryId: entry.id as string,
                                role: message.role,
                                snippet: found.snippet,
                            });
                            break;
                        }
                    }
                }
            }
            if (matches.length >= MAX_TRANSCRIPT_MATCHES_PER_PAGE) break;
            lastYieldAt = await yieldIfNeeded(lastYieldAt);
        }
        if (
            input.signal.aborted ||
            Date.now() >= input.deadlineAt ||
            manager.getSessionId() !== input.expectedSessionId
        )
            return unavailablePage(sessionId, anchorLeafId, input.startIndex);
        const currentLeaf = manager.getLeafId();
        const activeBranch = readBranch(manager, currentLeaf);
        if (
            !activeBranch ||
            (anchorLeafId === ''
                ? currentLeaf !== null || activeBranch.length !== 0
                : !activeBranch.some((entry) => entry.id === anchorLeafId)) ||
            input.signal.aborted ||
            Date.now() >= input.deadlineAt ||
            manager.getSessionId() !== input.expectedSessionId
        )
            return unavailablePage(sessionId, anchorLeafId, input.startIndex);
        return {
            sessionId,
            anchorLeafId,
            nextIndex,
            matches,
            complete: nextIndex >= branch.length,
            unavailable: false,
        };
    } catch {
        return unavailablePage(sessionId, anchorLeafId, input.startIndex);
    }
}
