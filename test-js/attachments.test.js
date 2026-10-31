// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import {
    formatAttachment,
    extractImageItems,
    extractImageFiles,
    newAttachmentID,
    uploadAttachmentItem,
    getAttachmentItemStatus,
    getAttachmentPiContext,
    sendAttachmentPrompt,
    getAttachmentSendStatus,
    AttachmentRequestError,
    formatChipName,
} from '../web/attachments.js';

// Pure helper tests — these need no DOM, no fetch, no class wiring.
// The DOM-level integration (drop event → chip, paste event → upload,
// send integration) is tested in attachmentIntegration.test.js.

setupDomHarness();

describe('formatAttachment', () => {
    const att = {
        id: 'a1',
        name: 'shot.png',
        path: '/tmp/shot.png',
        type: 'image/png',
        sizeBytes: 1024,
        source: 'paste',
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
        const long = `${'a'.repeat(80)}.png`;
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

describe('newAttachmentID', () => {
    it('returns a canonical UUIDv4', () => {
        expect(newAttachmentID()).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
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
            path: '/home/u/.phi/clipboard/clip-1234-abcd.png',
            name: 'clip-1234-abcd.png',
            sizeBytes: 16,
            mimeType: 'image/png',
        };

        const { uploadClipboardImage } = await import('../web/attachments.js');
        const attachment = await uploadClipboardImage(blob, 'screenshot.png');

        expect(lastUrl).toBe('/api/attachments');
        expect(lastInit.method).toBe('POST');
        expect(lastInit.body).toBeInstanceOf(FormData);

        expect(attachment.path).toBe(
            '/home/u/.phi/clipboard/clip-1234-abcd.png',
        );
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

    it('falls back to blob.type and blob.size when server omits them', async () => {
        const blob = new Blob([new Uint8Array(8)], { type: 'image/jpeg' });
        response = { path: '/x.jpg', name: 'x.jpg' };
        const { uploadClipboardImage } = await import('../web/attachments.js');
        const a = await uploadClipboardImage(blob, 'x.jpg');
        expect(a.type).toBe('image/jpeg');
        expect(a.sizeBytes).toBe(8);
    });
});

describe('attachment v2 request helpers', () => {
    let lastUrl;
    let lastInit;
    let fetchResponse;
    const owner = {
        profileId: 'profile-a',
        origin: 'https://phi-a.example',
        paneId: 'pane-a',
        cwd: '/project-a',
        scope: {
            signal: new AbortController().signal,
            headers: () => ({ 'X-Phi-Backend': 'wrong-profile' }),
        },
    };

    beforeEach(() => {
        lastUrl = null;
        lastInit = null;
        fetchResponse = null;
        mockFetch((url, options) => {
            lastUrl = url;
            lastInit = options;
            return fetchResponse;
        });
    });

    it('uploads one file to the captured pane with the captured backend header', async () => {
        fetchResponse = {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            name: 'note.txt',
            path: '/private/note.bin',
            sizeBytes: 3,
            mimeType: 'application/octet-stream',
            kind: 'file',
            sha256: 'a'.repeat(64),
        };
        const file = new File(['abc'], 'note.txt', { type: 'text/plain' });
        const item = await uploadAttachmentItem(
            file,
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            owner,
        );
        expect(lastUrl).toBe(
            '/api/attachments/v2/items/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        );
        expect(lastInit.method).toBe('PUT');
        expect(lastInit.credentials).toBe('same-origin');
        expect(lastInit.headers['X-Phi-Backend']).toBe('profile-a');
        expect(lastInit.body.get('pane')).toBe('pane-a');
        expect(lastInit.body.get('name')).toBe('note.txt');
        expect(lastInit.body.get('file')).toBeInstanceOf(File);
        expect(item.source).toBe('device');
    });

    it('uses read-only status and context requests', async () => {
        fetchResponse = { state: 'missing' };
        await expect(
            getAttachmentItemStatus(
                'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                owner,
            ),
        ).resolves.toEqual({ state: 'missing' });
        expect(lastInit.method).toBe('GET');
        expect(lastUrl).toContain('pane=pane-a');
        fetchResponse = { available: false };
        await getAttachmentPiContext(owner);
        expect(lastUrl).toBe('/api/pi-bridge/attachments/context?pane=pane-a');
        expect(lastInit.method).toBe('GET');
    });

    it.each([undefined, { signal: new AbortController().signal }])(
        'keeps JSON headers when the captured owner has no header helper (%s)',
        async (scope) => {
            fetchResponse = {
                id: 'send',
                state: 'unknown',
                reason: 'uncertain',
            };
            await sendAttachmentPrompt({ ...owner, scope }, { id: 'send' });
            expect(new Headers(lastInit.headers).get('Content-Type')).toBe(
                'application/json',
            );
            expect(new Headers(lastInit.headers).get('X-Phi-Backend')).toBe(
                'profile-a',
            );
        },
    );

    it('posts the frozen snapshot and reads its status without replay', async () => {
        const body = {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            pane: 'pane-a',
            context: {
                process_id: 'proc',
                generation: '1',
                session_id: 'sess',
                leaf_id: '',
                model: null,
            },
            text: 'inspect',
            attachment_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        };
        fetchResponse = { id: body.id, state: 'unknown', reason: 'uncertain' };
        await sendAttachmentPrompt(owner, body);
        expect(lastUrl).toBe('/api/pi-bridge/attachments');
        expect(lastInit.method).toBe('POST');
        expect(JSON.parse(lastInit.body)).toEqual(body);
        fetchResponse = { id: body.id, state: 'unknown', reason: 'uncertain' };
        await getAttachmentSendStatus(owner, body.id);
        expect(lastInit.method).toBe('GET');
        expect(lastUrl).toContain('pane=pane-a');
        expect(lastUrl).toContain(`id=${body.id}`);
    });

    it('keeps a timed-out mutation unknown and does not send again', async () => {
        let calls = 0;
        const abortController = new AbortController();
        mockFetch(() => {
            calls += 1;
            return new Promise(() => {});
        });
        const pending = sendAttachmentPrompt(
            owner,
            {
                id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                pane: owner.paneId,
                context: {
                    process_id: 'proc',
                    generation: '1',
                    session_id: 's',
                    leaf_id: 'l',
                    model: null,
                },
                text: '',
                attachment_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            },
            abortController.signal,
        );
        abortController.abort();
        await expect(pending).rejects.toMatchObject({
            status: 0,
            reason: 'uncertain',
            uncertain: true,
        });
        expect(calls).toBe(1);
        expect(AttachmentRequestError).toBeDefined();
    });

    it('classifies malformed mutation responses as uncertain', async () => {
        mockFetch(() => ({ ok: true, status: 200, text: '{bad json' }));
        await expect(
            sendAttachmentPrompt(owner, {
                id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                pane: owner.paneId,
                context: {
                    process_id: 'proc',
                    generation: '1',
                    session_id: 's',
                    leaf_id: 'l',
                    model: null,
                },
                text: '',
                attachment_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
        ).rejects.toMatchObject({
            status: 200,
            reason: 'uncertain',
            uncertain: true,
        });
    });
});
