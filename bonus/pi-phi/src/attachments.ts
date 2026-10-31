import { createHash } from 'node:crypto';
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    readSync,
    realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export type AttachmentPromptContent = Parameters<
    ExtensionAPI['sendUserMessage']
>[0];

export interface AttachmentPromptRef {
    readonly basename: string;
    readonly sizeBytes: number;
    readonly mimeType: string;
    readonly kind: string;
    readonly sha256: string;
}

export interface AttachmentLatchState {
    highWater: bigint | null;
    active: { readonly requestId: string; readonly runtimeId: string } | null;
}

export function freshAttachmentLatch(): AttachmentLatchState {
    return { highWater: null, active: null };
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_NAME_BYTES = 128;
const MAX_REFS = 8;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const CHUNK_BYTES = 64 * 1024;

export function hasSafeAttachmentRoot(root: string | undefined): boolean {
    if (!root || !isAbsolute(root)) return false;
    if (!Number.isInteger(constants.O_NOFOLLOW) || !constants.O_NOFOLLOW)
        return false;
    if (!Number.isInteger(constants.O_NONBLOCK) || !constants.O_NONBLOCK)
        return false;
    try {
        const stat = lstatSync(root);
        return (
            stat.isDirectory() &&
            !stat.isSymbolicLink() &&
            isAbsolute(realpathSync.native(root))
        );
    } catch {
        return false;
    }
}

function validBasename(name: string): boolean {
    if (!name || name.length > MAX_NAME_BYTES || name === '.' || name === '..')
        return false;
    if (name.includes('/') || name.includes('\\') || name.includes('..'))
        return false;
    return /^[A-Za-z0-9._-]+$/.test(name);
}

function isPNG(data: Buffer): boolean {
    return (
        data.length >= 8 &&
        data
            .subarray(0, 8)
            .equals(
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            )
    );
}

function isJPEG(data: Buffer): boolean {
    return (
        data.length >= 3 &&
        data[0] === 0xff &&
        data[1] === 0xd8 &&
        data[2] === 0xff
    );
}

function looksLikeImage(data: Buffer): boolean {
    if (isPNG(data) || isJPEG(data)) return true;
    if (
        data.length >= 6 &&
        (data.subarray(0, 6).toString('ascii') === 'GIF87a' ||
            data.subarray(0, 6).toString('ascii') === 'GIF89a')
    )
        return true;
    if (
        data.length >= 12 &&
        data.subarray(0, 4).toString('ascii') === 'RIFF' &&
        data.subarray(8, 12).toString('ascii') === 'WEBP'
    )
        return true;
    if (data.length >= 2 && data.subarray(0, 2).toString('ascii') === 'BM')
        return true;
    if (data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brand = data.subarray(8, 12).toString('ascii');
        if (
            [
                'heic',
                'heix',
                'hevc',
                'hevx',
                'mif1',
                'msf1',
                'avif',
                'avis',
            ].includes(brand)
        )
            return true;
    }
    return data
        .subarray(0, Math.min(data.length, 1 << 20))
        .toString('utf8')
        .toLowerCase()
        .includes('<svg');
}

function readChecked(root: string, ref: AttachmentPromptRef): Buffer {
    if (
        !validBasename(ref.basename) ||
        !Number.isSafeInteger(ref.sizeBytes) ||
        ref.sizeBytes < 0 ||
        ref.sizeBytes > MAX_FILE_BYTES
    ) {
        throw new Error('invalid-item');
    }
    if (ref.kind !== 'file' && ref.kind !== 'image')
        throw new Error('invalid-item');
    if (
        ref.kind === 'image' &&
        ref.mimeType !== 'image/png' &&
        ref.mimeType !== 'image/jpeg'
    ) {
        throw new Error('unsupported-image');
    }
    if (ref.kind === 'file' && ref.mimeType !== 'application/octet-stream')
        throw new Error('invalid-item');

    const rootPath = realpathSync.native(root);
    const target = resolve(rootPath, ref.basename);
    if (dirname(target) !== rootPath) throw new Error('invalid-item');
    const before = lstatSync(target);
    if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.size !== ref.sizeBytes
    )
        throw new Error('invalid-item');
    const fd = openSync(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
        const opened = fstatSync(fd);
        if (
            !opened.isFile() ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size !== ref.sizeBytes
        ) {
            throw new Error('invalid-item');
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let position = 0;
        while (total <= MAX_FILE_BYTES) {
            const chunk = Buffer.allocUnsafe(
                Math.min(CHUNK_BYTES, MAX_FILE_BYTES + 1 - total),
            );
            const count = readSync(fd, chunk, 0, chunk.length, position);
            if (count === 0) break;
            chunks.push(chunk.subarray(0, count));
            total += count;
            position += count;
        }
        if (total !== ref.sizeBytes) throw new Error('invalid-item');
        const after = fstatSync(fd);
        if (
            after.dev !== opened.dev ||
            after.ino !== opened.ino ||
            after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs
        ) {
            throw new Error('invalid-item');
        }
        const data = Buffer.concat(chunks, total);
        const digest = createHash('sha256').update(data).digest('hex');
        if (digest !== ref.sha256) throw new Error('invalid-item');
        if (ref.kind === 'image') {
            if (ref.mimeType === 'image/png' && !isPNG(data))
                throw new Error('unsupported-image');
            if (ref.mimeType === 'image/jpeg' && !isJPEG(data))
                throw new Error('unsupported-image');
        } else if (looksLikeImage(data)) {
            throw new Error('unsupported-image');
        }
        return data;
    } finally {
        closeSync(fd);
    }
}

export function prepareAttachmentContent(
    root: string | undefined,
    text: string,
    refs: readonly AttachmentPromptRef[],
): { content: AttachmentPromptContent; hasImage: boolean } {
    if (!hasSafeAttachmentRoot(root)) throw new Error('unavailable');
    if (
        Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES ||
        refs.length < 1 ||
        refs.length > MAX_REFS
    ) {
        throw new Error('limit');
    }
    const seen = new Set<string>();
    let total = 0;
    const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; mimeType: string; data: string }
    > = [{ type: 'text', text }];
    let hasImage = false;
    for (const ref of refs) {
        if (seen.has(ref.basename)) throw new Error('invalid-item');
        seen.add(ref.basename);
        total += ref.sizeBytes;
        if (total > MAX_TOTAL_BYTES) throw new Error('limit');
        const bytes = readChecked(root!, ref);
        if (ref.kind === 'image') {
            hasImage = true;
            content.push({
                type: 'image',
                mimeType: ref.mimeType,
                data: bytes.toString('base64'),
            });
        } else {
            const absolutePath = resolve(root!, ref.basename);
            content.push({
                type: 'text',
                text: `Attached file path (JSON-quoted): ${JSON.stringify(absolutePath)}`,
            });
        }
    }
    return { content, hasImage };
}

export function safeAttachmentFailureReason(error: unknown): string {
    const raw = error instanceof Error ? error.message : '';
    const allowed = new Set([
        'unavailable',
        'stale',
        'busy',
        'queued',
        'compaction-active',
        'pending',
        'command',
        'unsupported-image',
        'unsupported-model',
        'missing-item',
        'invalid-item',
        'limit',
        'storage',
        'uncertain',
        'error',
    ]);
    return allowed.has(raw) ? raw : 'invalid-item';
}

export function parseAttachmentRequestID(value: string): bigint | null {
    if (!/^[1-9][0-9]{0,19}$/.test(value)) return null;
    try {
        const parsed = BigInt(value);
        return parsed <= 0xffff_ffff_ffff_ffffn ? parsed : null;
    } catch {
        return null;
    }
}
