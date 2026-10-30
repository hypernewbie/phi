/* Φ phi — staged-input attachments (drag-drop + clipboard image paste) */

// Attachment is the shared shape for both drag-drop and clipboard-image
// paths. Both entry points produce one of these; the rest of the system
// (chip strip, send integration) treats them identically.
export interface Attachment {
    id: string; // stable client-side id for chip keying
    name: string; // display name (server-generated for clipboard; original filename for drops)
    path: string; // absolute filesystem path — what we send to the coder
    type: string; // MIME
    sizeBytes: number;
    source: 'drop' | 'paste';
}

export interface AttachmentOwner {
    readonly profileId: string;
    readonly origin: string;
    readonly paneId: string;
    readonly cwd: string;
    readonly scope?: {
        readonly signal?: AbortSignal;
        headers?(extra?: HeadersInit): Record<string, string>;
    };
}

export interface AttachmentItem {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly type: string;
    readonly sizeBytes: number;
    readonly kind: 'image' | 'file';
    readonly sha256: string;
    readonly source: 'device' | 'server';
}

export interface AttachmentItemStatus {
    readonly state: 'ready' | 'receiving' | 'missing';
    readonly item?: AttachmentItem;
}

export interface AttachmentPiContext {
    readonly process_id: string | null;
    readonly generation: string | null;
    readonly session_id: string | null;
    readonly leaf_id: string | null;
    readonly model: { readonly provider: string; readonly id: string } | null;
    readonly idle: boolean | null;
    readonly queued: boolean | null;
    readonly image_available: boolean | null;
    readonly available: boolean;
}

export class AttachmentRequestError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly reason: string,
        readonly uncertain: boolean,
    ) {
        super(message);
        this.name = 'AttachmentRequestError';
    }
}

const ATTACHMENT_READ_TIMEOUT_MS = 10_000;
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 11 * 60_000;

export function newAttachmentID(): string {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.getRandomValues) throw new Error('secure-random-unavailable');
    if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function attachmentFetch<T>(
    owner: AttachmentOwner,
    url: string,
    init: RequestInit,
    timeoutMs: number,
    externalSignal?: AbortSignal,
): Promise<T> {
    const controller = new AbortController();
    let rejectAbort!: (error: AttachmentRequestError) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
    });
    let settled = false;
    const cancel = (reason: string) => {
        if (settled) return;
        controller.abort();
        rejectAbort(new AttachmentRequestError(reason, 0, 'uncertain', true));
    };
    const onScopeAbort = () => cancel('Attachment owner changed');
    const onExternalAbort = () => cancel('Attachment request cancelled');
    owner.scope?.signal?.addEventListener('abort', onScopeAbort, { once: true });
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => cancel('Attachment request timed out'), timeoutMs);
    if (owner.scope?.signal?.aborted) onScopeAbort();
    if (externalSignal?.aborted) onExternalAbort();
    const headers = owner.scope?.headers?.(init.headers) ?? {};
    if (owner.profileId) headers['X-Phi-Backend'] = owner.profileId;
    const operation = (async () => {
        if (controller.signal.aborted) throw new DOMException('Attachment request aborted', 'AbortError');
        const response = await fetch(url, {
            ...init,
            headers,
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
            let reason = 'error';
            try {
                const parsed = JSON.parse(text) as { reason?: unknown };
                if (typeof parsed.reason === 'string') reason = parsed.reason;
            } catch {
                // The body is consumed, but a malformed response does not
                // prove that a mutation was refused.
                throw new AttachmentRequestError('Attachment result unknown', response.status, 'uncertain', true);
            }
            const uncertain = response.status === 503 || response.status >= 500;
            throw new AttachmentRequestError(
                uncertain ? 'Attachment result unknown' : `Attachment refused: ${reason}`,
                response.status,
                reason,
                uncertain,
            );
        }
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new AttachmentRequestError('Attachment result unknown', response.status, 'uncertain', true);
        }
    })();
    try {
        return await Promise.race([operation, aborted]);
    } catch (error) {
        if (error instanceof AttachmentRequestError) throw error;
        throw new AttachmentRequestError('Attachment result unknown', 0, 'uncertain', true);
    } finally {
        settled = true;
        clearTimeout(timer);
        owner.scope?.signal?.removeEventListener('abort', onScopeAbort);
        externalSignal?.removeEventListener('abort', onExternalAbort);
    }
}

export async function uploadAttachmentItem(
    file: File,
    id: string,
    owner: AttachmentOwner,
    signal?: AbortSignal,
): Promise<AttachmentItem> {
    const form = new FormData();
    form.append('pane', owner.paneId);
    form.append('name', file.name);
    form.append('file', file, file.name || 'attachment');
    const item = await attachmentFetch<AttachmentItem>(
        owner,
        `/api/attachments/v2/items/${encodeURIComponent(id)}`,
        { method: 'PUT', body: form },
        ATTACHMENT_UPLOAD_TIMEOUT_MS,
        signal,
    );
    return { ...item, source: 'device' };
}

export function getAttachmentItemStatus(
    id: string,
    owner: AttachmentOwner,
    signal?: AbortSignal,
): Promise<AttachmentItemStatus> {
    const query = new URLSearchParams({ pane: owner.paneId });
    return attachmentFetch<AttachmentItemStatus>(
        owner,
        `/api/attachments/v2/items/${encodeURIComponent(id)}?${query}`,
        { method: 'GET' },
        ATTACHMENT_READ_TIMEOUT_MS,
        signal,
    );
}

export function getAttachmentPiContext(
    owner: AttachmentOwner,
    signal?: AbortSignal,
): Promise<AttachmentPiContext> {
    const query = new URLSearchParams({ pane: owner.paneId });
    return attachmentFetch<AttachmentPiContext>(
        owner,
        `/api/pi-bridge/attachments/context?${query}`,
        { method: 'GET' },
        ATTACHMENT_READ_TIMEOUT_MS,
        signal,
    );
}

export interface AttachmentSendBody {
    readonly id: string;
    readonly pane: string;
    readonly context: {
        readonly process_id: string;
        readonly generation: string;
        readonly session_id: string;
        readonly leaf_id: string;
        readonly model: { readonly provider: string; readonly id: string } | null;
    };
    readonly text: string;
    readonly attachment_ids: readonly string[];
}

export interface AttachmentSendResult {
    readonly id: string;
    readonly state: 'refused' | 'dispatched' | 'unknown' | 'missing';
    readonly reason: string;
}

export function sendAttachmentPrompt(
    owner: AttachmentOwner,
    body: AttachmentSendBody,
    signal?: AbortSignal,
): Promise<AttachmentSendResult> {
    return attachmentFetch<AttachmentSendResult>(
        owner,
        '/api/pi-bridge/attachments',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        45_000,
        signal,
    );
}

export function getAttachmentSendStatus(
    owner: AttachmentOwner,
    id: string,
    signal?: AbortSignal,
): Promise<AttachmentSendResult> {
    const query = new URLSearchParams({ pane: owner.paneId, id });
    return attachmentFetch<AttachmentSendResult>(
        owner,
        `/api/pi-bridge/attachments?${query}`,
        { method: 'GET' },
        ATTACHMENT_READ_TIMEOUT_MS,
        signal,
    );
}

export interface ServerFileEntry {
    readonly name: string;
    readonly path: string;
    readonly kind: string;
    readonly sizeBytes?: number;
    readonly fingerprint?: string;
}

export interface ServerFileListing {
    readonly path: string;
    readonly parent: string;
    readonly truncated: boolean;
    readonly entries: readonly ServerFileEntry[];
}

export function browseServerFiles(
    owner: AttachmentOwner,
    path: string,
    signal?: AbortSignal,
): Promise<ServerFileListing> {
    const query = new URLSearchParams({ pane: owner.paneId, path });
    return attachmentFetch<ServerFileListing>(
        owner,
        `/api/attachments/v2/browse?${query}`,
        { method: 'GET' },
        ATTACHMENT_READ_TIMEOUT_MS,
        signal,
    );
}

export interface ServerFileSnapshot {
    readonly id: string;
    readonly path: string;
    readonly fingerprint: string;
}

export async function snapshotServerFile(
    owner: AttachmentOwner,
    snapshot: ServerFileSnapshot,
    signal?: AbortSignal,
): Promise<AttachmentItem> {
    const item = await attachmentFetch<AttachmentItem>(
        owner,
        '/api/attachments/v2/server-items',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: snapshot.id,
                pane: owner.paneId,
                path: snapshot.path,
                expected_fingerprint: snapshot.fingerprint,
            }),
        },
        ATTACHMENT_READ_TIMEOUT_MS,
        signal,
    );
    return { ...item, source: 'server' };
}

// formatAttachment is the single source of truth for coder-specific
// path formatting. Delegates to the registry-aware implementation in
// web-src/coders.ts so every call site (markdown.ts, filetree.ts,
// terminal.js) gets the same answer. R8: the registry-backed path
// uses callback replacement to avoid String.replace $& interpretation.
export function formatAttachment(
    coder: string,
    attachment: Attachment | string,
): string {
    const path = typeof attachment === 'string' ? attachment : attachment.path;
    return registryFormatAttachment(coder, path);
}

// Registry lookup is implemented as a plain function call. coders.ts
// is bundled alongside this file, so the import resolves synchronously
// at module load — no circular dep, no dynamic-import shim.
import { formatAttachment as registryFormatAttachment } from './coders.js';

// ATTACHMENT_SYNTAX stays as a frozen reference map for any test that
// indexes it directly. Values mirror the registry fallback.
export const ATTACHMENT_SYNTAX: Record<string, (a: Attachment) => string> =
    Object.freeze({
        claude: (a) => `@${a.path}`,
        pi: (a) => a.path,
        opencode: (a) => `@${a.path}`,
        agy: (a) => `@${a.path}`,
        bash: (a) => a.path,
        pwsh: (a) => a.path,
    });

// DataTransferItemLike is the structural shape we read from a DataTransfer /
// DataTransferItemList, kept loose so it can be supplied by both real
// browser events and jsdom tests (jsdom does not implement DataTransfer).
export interface DataTransferItemLike {
    kind: string; // 'file' | 'string'
    type: string; // MIME
    getAsFile?: () => Blob | null;
}

export interface DataTransferLike {
    items?:
        | DataTransferItemLike[]
        | { length: number; [i: number]: DataTransferItemLike };
    files?: FileList | { length: number; [i: number]: File };
}

// extractImageItems returns the image-bearing file items from a DataTransfer
// shape. Pure — no DOM mutation, no event reading. The drop/paste listeners
// pass `e.dataTransfer` / `e.clipboardData` in directly; tests pass plain
// objects with the same shape.
export function extractImageItems(
    dt: DataTransferLike | null | undefined,
): DataTransferItemLike[] {
    if (!dt?.items) return [];
    const items: DataTransferItemLike[] = [];
    const raw = dt.items;
    const len = (raw as { length: number }).length;
    for (let i = 0; i < len; i++) {
        const it = (raw as DataTransferItemLike[])[i];
        if (
            it &&
            it.kind === 'file' &&
            typeof it.type === 'string' &&
            it.type.startsWith('image/')
        ) {
            items.push(it);
        }
    }
    return items;
}

// extractImageFiles walks a FileList-like and returns the image-typed
// entries. Used by the drop handler where we read files directly rather
// than going through items (drops don't always expose getAsFile consistently
// across browsers — files does).
export function extractImageFiles(
    files: FileList | { length: number; [i: number]: File } | null | undefined,
): File[] {
    if (!files) return [];
    const out: File[] = [];
    const len = (files as { length: number }).length;
    for (let i = 0; i < len; i++) {
        const f = (files as File[])[i];
        if (f && typeof f.type === 'string' && f.type.startsWith('image/')) {
            out.push(f);
        }
    }
    return out;
}

// attachmentClientId is a local id for chip keying. We don't need a real
// UUID — a monotonic counter is fine because chip keys are only used
// within a single tab's lifetime.
let _attachmentCounter = 0;
export function attachmentClientId(): string {
    _attachmentCounter += 1;
    return `att-${Date.now().toString(36)}-${_attachmentCounter}`;
}

// uploadClipboardImage POSTs a single image blob to /api/attachments and
// resolves to an Attachment on success. Both drag-drop and paste go through
// this because modern browsers do not expose real OS paths on File objects.
//
// The filename hint is informational only — the server ignores it and
// generates a unique name itself to avoid collisions when the user pastes
// multiple images in quick succession.
export async function uploadClipboardImage(
    blob: Blob,
    filenameHint: string,
): Promise<Attachment> {
    const form = new FormData();
    // The third arg to append is the filename sent on the multipart part.
    // The server still ignores this and assigns its own name.
    form.append('file', blob, filenameHint || 'clipboard');

    const res = await fetch('/api/attachments', { method: 'POST', body: form });
    if (!res.ok) {
        throw new Error(
            `Attachment upload failed: ${res.status} ${res.statusText}`,
        );
    }
    const json = (await res.json()) as {
        path: string;
        name: string;
        sizeBytes: number;
        mimeType: string;
    };
    return {
        id: attachmentClientId(),
        name: json.name || filenameHint || 'attachment',
        path: json.path,
        type: json.mimeType || blob.type || 'application/octet-stream',
        sizeBytes:
            typeof json.sizeBytes === 'number' ? json.sizeBytes : blob.size,
        source: 'paste',
    };
}

// formatChipName shortens long paths for chip display. Pure; unit-testable.
export function formatChipName(name: string, max = 40): string {
    if (!name) return 'attachment';
    if (name.length <= max) return name;
    // Keep start + end, ellipsize the middle. Preserves the file extension.
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const keep = Math.max(4, max - ext.length - 1);
    const head = stem.slice(0, Math.ceil(keep / 2));
    const tail = stem.slice(-Math.floor(keep / 2));
    return `${head}…${tail}${ext}`;
}
