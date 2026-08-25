// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import {
    formatAttachment,
    extractImageItems,
    extractImageFiles,
    formatChipName,
    releaseAttachment,
    cloneAttachment,
} from '../web/attachments.js';

// Pure helper tests — these need no DOM, no fetch, no class wiring.
// The DOM-level integration (drop event → chip, paste event → upload,
// send integration) is tested in attachmentIntegration.test.js.

setupDomHarness();

describe('formatAttachment', () => {
    const att = {
        path: '/tmp/shot.png',
    };

    it('prefixes @ for vision-capable coding agents', () => {
        for (const coder of ['claude', 'opencode', 'agy']) {
            expect(formatAttachment(coder, att)).toBe(`@${att.path}`);
        }
    });

    it('uses raw path for pi (pi reads paths natively)', () => {
        // pi is a coding agent but its CLI doesn't use the @path mention
        // syntax the way Claude/OpenCode/Antigravity do — it resolves
        // bare paths. Treat it like a shell for attachment purposes.
        expect(formatAttachment('pi', att)).toBe(att.path);
    });

    it('uses raw path for shell coders', () => {
        expect(formatAttachment('bash', att)).toBe(att.path);
        expect(formatAttachment('pwsh', att)).toBe(att.path);
    });

    it('falls back to raw path for unknown coders', () => {
        expect(formatAttachment('gpt', att)).toBe(att.path);
        expect(formatAttachment('', att)).toBe(att.path);
    });
});

describe('extractImageItems', () => {
    it('returns only image file items', () => {
        const items = [
            { kind: 'file', type: 'image/png', getAsFile: () => ({}) },
            { kind: 'file', type: 'image/jpeg', getAsFile: () => ({}) },
            { kind: 'file', type: 'text/plain', getAsFile: () => ({}) },
            { kind: 'string', type: 'text/plain' },
        ];
        const out = extractImageItems({ items });
        expect(out).toHaveLength(2);
        expect(out[0].type).toBe('image/png');
        expect(out[1].type).toBe('image/jpeg');
    });

    it('returns [] for null/undefined/missing items', () => {
        expect(extractImageItems(null)).toEqual([]);
        expect(extractImageItems(undefined)).toEqual([]);
        expect(extractImageItems({})).toEqual([]);
    });

    it('treats array-like length+index items correctly', () => {
        const itemsLike = {
            length: 2,
            0: { kind: 'file', type: 'image/gif' },
            1: { kind: 'file', type: 'application/json' },
        };
        expect(extractImageItems({ items: itemsLike })).toHaveLength(1);
    });
});

describe('extractImageFiles', () => {
    it('returns only image-typed files', () => {
        const files = [
            new File([new Uint8Array(8)], 'a.png', { type: 'image/png' }),
            new File([new Uint8Array(8)], 'b.txt', { type: 'text/plain' }),
            new File([new Uint8Array(8)], 'c.webp', { type: 'image/webp' }),
        ];
        const out = extractImageFiles(files);
        expect(out).toHaveLength(2);
        expect(out[0].name).toBe('a.png');
        expect(out[1].name).toBe('c.webp');
    });

    it('returns [] for empty/null', () => {
        expect(extractImageFiles(null)).toEqual([]);
        expect(extractImageFiles(undefined)).toEqual([]);
        expect(extractImageFiles([])).toEqual([]);
    });
});

describe('formatChipName', () => {
    it('returns short names unchanged', () => {
        expect(formatChipName('foo.png', 40)).toBe('foo.png');
    });

    it('middle-ellipsizes long names but preserves the extension', () => {
        const long = 'a'.repeat(80) + '.png';
        const out = formatChipName(long, 30);
        expect(out.endsWith('.png')).toBe(true);
        expect(out.length).toBeLessThanOrEqual(30);
        expect(out).toContain('…');
    });

    it('handles names without an extension', () => {
        const long = 'b'.repeat(80);
        const out = formatChipName(long, 30);
        expect(out.length).toBeLessThanOrEqual(30);
        expect(out).toContain('…');
    });

    it('returns the empty-string sentinel for falsy input', () => {
        expect(formatChipName('', 40)).toBe('attachment');
    });
});

// uploadClipboardImage touches fetch — test the network boundary directly.
describe('uploadClipboardImage', () => {
    let lastUrl;
    let lastInit;
    let response;

    beforeEach(() => {
        lastUrl = null;
        lastInit = null;
        response = null;
        mockFetch((url, options) => {
            lastUrl = url;
            lastInit = options;
            return response;
        });
    });

    it('POSTs multipart/form-data and resolves to an Attachment', async () => {
        const blob = new Blob([new Uint8Array(16)], { type: 'image/png' });
        response = {
            ref: 'a'.repeat(64),
            name: 'clip-1234-abcd.png',
            sizeBytes: 16,
            mimeType: 'image/png',
        };

        const { uploadClipboardImage } = await import('../web/attachments.js');
        const attachment = await uploadClipboardImage(blob, 'screenshot.png');

        expect(lastUrl).toBe('/api/attachments');
        expect(lastInit.method).toBe('POST');
        expect(lastInit.body).toBeInstanceOf(FormData);

        expect(attachment.ref).toBe('a'.repeat(64));
        expect(attachment).not.toHaveProperty('path');
        expect(attachment.name).toBe('clip-1234-abcd.png');
        expect(attachment.type).toBe('image/png');
        expect(attachment.sizeBytes).toBe(16);
        expect(attachment.source).toBe('paste');
        expect(attachment.id).toMatch(/^att-/);
    });

    it('throws on non-2xx response', async () => {
        const blob = new Blob([new Uint8Array(8)], { type: 'image/png' });
        // mockFetch returns ok=true unless we explicitly set ok:false.
        response = { ok: false, status: 413, json: { error: 'too large' } };
        const { uploadClipboardImage } = await import('../web/attachments.js');
        await expect(uploadClipboardImage(blob, 'big.png')).rejects.toThrow(
            /413/,
        );
    });

    it('rejects a legacy path response', async () => {
        const blob = new Blob([new Uint8Array(8)], { type: 'image/png' });
        response = {
            path: '/x.png',
            name: 'x.png',
            sizeBytes: 8,
            mimeType: 'image/png',
        };
        const { uploadClipboardImage } = await import('../web/attachments.js');
        await expect(uploadClipboardImage(blob, 'x.png')).rejects.toThrow(
            /opaque ref/,
        );
    });

    it('falls back to blob.type and blob.size when server omits them', async () => {
        const blob = new Blob([new Uint8Array(8)], { type: 'image/jpeg' });
        response = { ref: 'b'.repeat(64), name: 'x.jpg' };
        const { uploadClipboardImage } = await import('../web/attachments.js');
        const a = await uploadClipboardImage(blob, 'x.jpg');
        expect(a.type).toBe('image/jpeg');
        expect(a.sizeBytes).toBe(8);
    });

    it('releases a provisional ref and clones with a fresh local id', async () => {
        response = { released: true };
        expect(await releaseAttachment('c'.repeat(64))).toBe(true);
        expect(lastUrl).toBe('/api/attachments/release');
        const original = {
            id: 'old',
            ref: 'a'.repeat(64),
            name: 'x.png',
            type: 'image/png',
            sizeBytes: 8,
            source: 'paste',
        };
        const copy = cloneAttachment(original, 'd'.repeat(64));
        expect(copy.ref).toBe('d'.repeat(64));
        expect(copy.id).not.toBe(original.id);
    });
});
