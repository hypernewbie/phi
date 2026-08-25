/* Φ phi — staged-input attachments (drag-drop + clipboard image paste) */
const ATTACHMENT_SYNTAX = {
    claude: (path) => `@${path}`,
    opencode: (path) => `@${path}`,
    agy: (path) => `@${path}`,
    bash: (path) => path,
    pwsh: (path) => path,
};
export function formatAttachment(coder, attachment) {
    const legacyPath = attachment.path;
    if (typeof legacyPath !== 'string' || legacyPath === '') {
        throw new Error('Uploaded images require a Pi RPC chat');
    }
    const fn = ATTACHMENT_SYNTAX[coder];
    return fn ? fn(legacyPath) : legacyPath;
}
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
let _attachmentCounter = 0;
export function attachmentClientId() {
    _attachmentCounter += 1;
    return `att-${Date.now().toString(36)}-${_attachmentCounter}`;
}
export async function uploadClipboardImage(blob, filenameHint) {
    const form = new FormData();
    form.append('file', blob, filenameHint || 'clipboard');
    const res = await fetch('/api/attachments', { method: 'POST', body: form });
    if (!res.ok) {
        throw new Error(`Attachment upload failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json());
    if (typeof json.ref !== 'string' || !/^[0-9a-f]{64}$/u.test(json.ref)) {
        throw new Error('Attachment upload response did not contain an opaque ref');
    }
    if ('path' in json) {
        throw new Error('Attachment upload response exposed a filesystem path');
    }
    return {
        id: attachmentClientId(),
        ref: json.ref,
        name: typeof json.name === 'string' && json.name
            ? json.name
            : filenameHint || 'attachment',
        type: typeof json.mimeType === 'string' && json.mimeType
            ? json.mimeType
            : blob.type || 'application/octet-stream',
        sizeBytes: typeof json.sizeBytes === 'number' ? json.sizeBytes : blob.size,
        source: 'paste',
    };
}
export async function releaseAttachment(ref) {
    if (!/^[0-9a-f]{64}$/u.test(ref))
        return false;
    const res = await fetch('/api/attachments/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref }),
    });
    if (!res.ok) {
        throw new Error(`Attachment release failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json());
    return json.released === true;
}
export function cloneAttachment(attachment, ref) {
    if (!/^[0-9a-f]{64}$/u.test(ref)) {
        throw new Error('Attachment clone requires an opaque ref');
    }
    return { ...attachment, id: attachmentClientId(), ref };
}
export function formatChipName(name, max = 40) {
    if (!name)
        return 'attachment';
    if (name.length <= max)
        return name;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const keep = Math.max(4, max - ext.length - 1);
    const head = stem.slice(0, Math.ceil(keep / 2));
    const tail = stem.slice(-Math.floor(keep / 2));
    return `${head}…${tail}${ext}`;
}
