/* Φ phi — staged-input attachments (drag-drop + clipboard image paste) */
export class AttachmentRequestError extends Error {
    status;
    reason;
    uncertain;
    constructor(message, status, reason, uncertain) {
        super(message);
        this.status = status;
        this.reason = reason;
        this.uncertain = uncertain;
        this.name = 'AttachmentRequestError';
    }
}
const ATTACHMENT_READ_TIMEOUT_MS = 10_000;
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 11 * 60_000;
export function newAttachmentID() {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.getRandomValues)
        throw new Error('secure-random-unavailable');
    if (typeof cryptoApi.randomUUID === 'function')
        return cryptoApi.randomUUID();
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function attachmentFetch(owner, url, init, timeoutMs, externalSignal) {
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => {
        rejectAbort = reject;
    });
    let settled = false;
    const cancel = (reason) => {
        if (settled)
            return;
        controller.abort();
        rejectAbort(new AttachmentRequestError(reason, 0, 'uncertain', true));
    };
    const onScopeAbort = () => cancel('Attachment owner changed');
    const onExternalAbort = () => cancel('Attachment request cancelled');
    owner.scope?.signal?.addEventListener('abort', onScopeAbort, {
        once: true,
    });
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => cancel('Attachment request timed out'), timeoutMs);
    if (owner.scope?.signal?.aborted)
        onScopeAbort();
    if (externalSignal?.aborted)
        onExternalAbort();
    const headers = owner.scope?.headers?.(init.headers) ?? {};
    if (owner.profileId)
        headers['X-Phi-Backend'] = owner.profileId;
    const operation = (async () => {
        if (controller.signal.aborted)
            throw new DOMException('Attachment request aborted', 'AbortError');
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
                const parsed = JSON.parse(text);
                if (typeof parsed.reason === 'string')
                    reason = parsed.reason;
            }
            catch {
                // The body is consumed, but a malformed response does not
                // prove that a mutation was refused.
                throw new AttachmentRequestError('Attachment result unknown', response.status, 'uncertain', true);
            }
            const uncertain = response.status === 503 || response.status >= 500;
            throw new AttachmentRequestError(uncertain
                ? 'Attachment result unknown'
                : `Attachment refused: ${reason}`, response.status, reason, uncertain);
        }
        try {
            return JSON.parse(text);
        }
        catch {
            throw new AttachmentRequestError('Attachment result unknown', response.status, 'uncertain', true);
        }
    })();
    try {
        return await Promise.race([operation, aborted]);
    }
    catch (error) {
        if (error instanceof AttachmentRequestError)
            throw error;
        throw new AttachmentRequestError('Attachment result unknown', 0, 'uncertain', true);
    }
    finally {
        settled = true;
        clearTimeout(timer);
        owner.scope?.signal?.removeEventListener('abort', onScopeAbort);
        externalSignal?.removeEventListener('abort', onExternalAbort);
    }
}
export async function uploadAttachmentItem(file, id, owner, signal) {
    const form = new FormData();
    form.append('pane', owner.paneId);
    form.append('name', file.name);
    form.append('file', file, file.name || 'attachment');
    const item = await attachmentFetch(owner, `/api/attachments/v2/items/${encodeURIComponent(id)}`, { method: 'PUT', body: form }, ATTACHMENT_UPLOAD_TIMEOUT_MS, signal);
    return { ...item, source: 'device' };
}
export function getAttachmentItemStatus(id, owner, signal) {
    const query = new URLSearchParams({ pane: owner.paneId });
    return attachmentFetch(owner, `/api/attachments/v2/items/${encodeURIComponent(id)}?${query}`, { method: 'GET' }, ATTACHMENT_READ_TIMEOUT_MS, signal);
}
export function getAttachmentPiContext(owner, signal) {
    const query = new URLSearchParams({ pane: owner.paneId });
    return attachmentFetch(owner, `/api/pi-bridge/attachments/context?${query}`, { method: 'GET' }, ATTACHMENT_READ_TIMEOUT_MS, signal);
}
export function attachmentRefusalNotice(reason) {
    const detail = reason === 'stale'
        ? 'Pi state changed before submission.'
        : reason === 'unavailable'
            ? 'Pi state could not be confirmed.'
            : `Submission was blocked (${reason || 'unavailable'}).`;
    return `Attachment not sent. ${detail} Restore it to edit and send again.`;
}
export function sendAttachmentPrompt(owner, body, signal) {
    return attachmentFetch(owner, '/api/pi-bridge/attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, 45_000, signal);
}
export function getAttachmentSendStatus(owner, id, signal) {
    const query = new URLSearchParams({ pane: owner.paneId, id });
    return attachmentFetch(owner, `/api/pi-bridge/attachments?${query}`, { method: 'GET' }, ATTACHMENT_READ_TIMEOUT_MS, signal);
}
export function browseServerFiles(owner, path, signal) {
    const query = new URLSearchParams({ pane: owner.paneId, path });
    return attachmentFetch(owner, `/api/attachments/v2/browse?${query}`, { method: 'GET' }, ATTACHMENT_READ_TIMEOUT_MS, signal);
}
export async function snapshotServerFile(owner, snapshot, signal) {
    const item = await attachmentFetch(owner, '/api/attachments/v2/server-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: snapshot.id,
            pane: owner.paneId,
            path: snapshot.path,
            expected_fingerprint: snapshot.fingerprint,
        }),
    }, ATTACHMENT_READ_TIMEOUT_MS, signal);
    return { ...item, source: 'server' };
}
// formatAttachment is the single source of truth for coder-specific
// path formatting. Delegates to the registry-aware implementation in
// web-src/coders.ts so every call site (markdown.ts, filetree.ts,
// terminal.js) gets the same answer. R8: the registry-backed path
// uses callback replacement to avoid String.replace $& interpretation.
export function formatAttachment(coder, attachment) {
    const path = typeof attachment === 'string' ? attachment : attachment.path;
    return registryFormatAttachment(coder, path);
}
// Registry lookup is implemented as a plain function call. coders.ts
// is bundled alongside this file, so the import resolves synchronously
// at module load — no circular dep, no dynamic-import shim.
import { formatAttachment as registryFormatAttachment } from './coders.js';
// ATTACHMENT_SYNTAX stays as a frozen reference map for any test that
// indexes it directly. Values mirror the registry fallback.
export const ATTACHMENT_SYNTAX = Object.freeze({
    claude: (a) => `@${a.path}`,
    pi: (a) => a.path,
    opencode: (a) => `@${a.path}`,
    agy: (a) => `@${a.path}`,
    bash: (a) => a.path,
    pwsh: (a) => a.path,
});
// extractImageItems returns the image-bearing file items from a DataTransfer
// shape. Pure — no DOM mutation, no event reading. The drop/paste listeners
// pass `e.dataTransfer` / `e.clipboardData` in directly; tests pass plain
// objects with the same shape.
export function extractImageItems(dt) {
    if (!dt?.items)
        return [];
    const items = [];
    const raw = dt.items;
    const len = raw.length;
    for (let i = 0; i < len; i++) {
        const it = raw[i];
        if (it &&
            it.kind === 'file' &&
            typeof it.type === 'string' &&
            it.type.startsWith('image/')) {
            items.push(it);
        }
    }
    return items;
}
// extractImageFiles walks a FileList-like and returns the image-typed
// entries. Used by the drop handler where we read files directly rather
// than going through items (drops don't always expose getAsFile consistently
// across browsers — files does).
export function extractImageFiles(files) {
    if (!files)
        return [];
    const out = [];
    const len = files.length;
    for (let i = 0; i < len; i++) {
        const f = files[i];
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
export function attachmentClientId() {
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
export async function uploadClipboardImage(blob, filenameHint) {
    const form = new FormData();
    // The third arg to append is the filename sent on the multipart part.
    // The server still ignores this and assigns its own name.
    form.append('file', blob, filenameHint || 'clipboard');
    const res = await fetch('/api/attachments', { method: 'POST', body: form });
    if (!res.ok) {
        throw new Error(`Attachment upload failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json());
    return {
        id: attachmentClientId(),
        name: json.name || filenameHint || 'attachment',
        path: json.path,
        type: json.mimeType || blob.type || 'application/octet-stream',
        sizeBytes: typeof json.sizeBytes === 'number' ? json.sizeBytes : blob.size,
        source: 'paste',
    };
}
// formatChipName shortens long paths for chip display. Pure; unit-testable.
export function formatChipName(name, max = 40) {
    if (!name)
        return 'attachment';
    if (name.length <= max)
        return name;
    // Keep start + end, ellipsize the middle. Preserves the file extension.
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const keep = Math.max(4, max - ext.length - 1);
    const head = stem.slice(0, Math.ceil(keep / 2));
    const tail = stem.slice(-Math.floor(keep / 2));
    return `${head}…${tail}${ext}`;
}
