/* Φ phi — staged-input attachments (drag-drop + clipboard image paste) */

export interface Attachment {
    id: string;
    ref: string;
    name: string;
    type: string;
    sizeBytes: number;
    source: 'drop' | 'paste';
    /** Legacy explicit-path callers (never populated by remote uploads). */
    path?: string;
}

// Generic coders may still use explicitly supplied pre-existing paths. Remote
// uploads never expose a path and are intended for Pi's images payload.
export interface ExplicitPathAttachment {
    path: string;
}

const ATTACHMENT_SYNTAX: Record<string, (path: string) => string> = {
    claude: (path) => `@${path}`,
    opencode: (path) => `@${path}`,
    agy: (path) => `@${path}`,
    bash: (path) => path,
    pwsh: (path) => path,
};

export function formatAttachment(
    coder: string,
    attachment: Attachment | ExplicitPathAttachment,
): string {
    const legacyPath = (attachment as ExplicitPathAttachment).path;
    if (typeof legacyPath !== 'string' || legacyPath === '') {
        throw new Error('Uploaded images require a Pi RPC chat');
    }
    const fn = ATTACHMENT_SYNTAX[coder];
    return fn ? fn(legacyPath) : legacyPath;
}

export interface DataTransferItemLike {
    kind: string;
    type: string;
    getAsFile?: () => Blob | null;
}

export interface DataTransferLike {
    items?:
        | DataTransferItemLike[]
        | { length: number; [i: number]: DataTransferItemLike };
    files?: FileList | { length: number; [i: number]: File };
}

export function extractImageItems(
    dt: DataTransferLike | null | undefined,
): DataTransferItemLike[] {
    if (!dt || !dt.items) return [];
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

let _attachmentCounter = 0;
export function attachmentClientId(): string {
    _attachmentCounter += 1;
    return `att-${Date.now().toString(36)}-${_attachmentCounter}`;
}

export async function uploadClipboardImage(
    blob: Blob,
    filenameHint: string,
): Promise<Attachment> {
    const form = new FormData();
    form.append('file', blob, filenameHint || 'clipboard');
    const res = await fetch('/api/attachments', { method: 'POST', body: form });
    if (!res.ok) {
        throw new Error(
            `Attachment upload failed: ${res.status} ${res.statusText}`,
        );
    }
    const json = (await res.json()) as {
        ref?: unknown;
        name?: unknown;
        sizeBytes?: unknown;
        mimeType?: unknown;
        path?: unknown;
    };
    if (typeof json.ref !== 'string' || !/^[0-9a-f]{64}$/u.test(json.ref)) {
        throw new Error(
            'Attachment upload response did not contain an opaque ref',
        );
    }
    if ('path' in json) {
        throw new Error('Attachment upload response exposed a filesystem path');
    }
    return {
        id: attachmentClientId(),
        ref: json.ref,
        name:
            typeof json.name === 'string' && json.name
                ? json.name
                : filenameHint || 'attachment',
        type:
            typeof json.mimeType === 'string' && json.mimeType
                ? json.mimeType
                : blob.type || 'application/octet-stream',
        sizeBytes:
            typeof json.sizeBytes === 'number' ? json.sizeBytes : blob.size,
        source: 'paste',
    };
}

export async function releaseAttachment(ref: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/u.test(ref)) return false;
    const res = await fetch('/api/attachments/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref }),
    });
    if (!res.ok) {
        throw new Error(
            `Attachment release failed: ${res.status} ${res.statusText}`,
        );
    }
    const json = (await res.json()) as { released?: unknown };
    return json.released === true;
}

export function cloneAttachment(
    attachment: Attachment,
    ref: string,
): Attachment {
    if (!/^[0-9a-f]{64}$/u.test(ref)) {
        throw new Error('Attachment clone requires an opaque ref');
    }
    return { ...attachment, id: attachmentClientId(), ref };
}

export function formatChipName(name: string, max = 40): string {
    if (!name) return 'attachment';
    if (name.length <= max) return name;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const keep = Math.max(4, max - ext.length - 1);
    const head = stem.slice(0, Math.ceil(keep / 2));
    const tail = stem.slice(-Math.floor(keep / 2));
    return `${head}…${tail}${ext}`;
}
