/* Φ phi — staged-input attachments (drag-drop + clipboard image paste) */
// ATTACHMENT_SYNTAX maps each coding-agent / shell coder to a function
// that formats an attachment path the way that coder expects to receive it.
//
// Today the agents that read images natively are Claude Code, OpenCode,
// Antigravity, and Pi; they all use the `@<path>` mention syntax. Plain
// shells (bash/pwsh) just want the path. Unknown coders fall back to the
// raw path so the user can still reference it in their prompt.
//
// Pseudo-coders (review, kanban) have no PTY to send to and are excluded
// from the send integration. sendStagedInput early-returns on those tabs.
//
// If a particular coder doesn't actually accept `@path`, edit this map —
// it's the only place that needs to change.
export const ATTACHMENT_SYNTAX = {
    claude: (a) => `@${a.path}`,
    pi: (a) => a.path,
    opencode: (a) => `@${a.path}`,
    agy: (a) => `@${a.path}`,
    bash: (a) => a.path,
    pwsh: (a) => a.path,
};
// formatAttachment returns the coder-specific mention token for an
// attachment. Unknown coders get the raw path (safer than guessing a
// mention syntax the agent doesn't recognize).
export function formatAttachment(coder, attachment) {
    const fn = ATTACHMENT_SYNTAX[coder];
    return fn ? fn(attachment) : attachment.path;
}
// extractImageItems returns the image-bearing file items from a DataTransfer
// shape. Pure — no DOM mutation, no event reading. The drop/paste listeners
// pass `e.dataTransfer` / `e.clipboardData` in directly; tests pass plain
// objects with the same shape.
export function extractImageItems(dt) {
    if (!dt || !dt.items)
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
