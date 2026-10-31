import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    hasSafeAttachmentRoot,
    prepareAttachmentContent,
} from './attachments.js';

const roots: string[] = [];
const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

function rootDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'phi-attachment-host-'));
    roots.push(root);
    return root;
}

function ref(
    name: string,
    bytes: Buffer,
    kind: 'file' | 'image',
    mimeType: string,
) {
    return {
        basename: name,
        sizeBytes: bytes.length,
        mimeType,
        kind,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
}

afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
});

describe('attachment handoff reader', () => {
    it('sends verified PNG bytes as native image content', () => {
        const root = rootDir();
        writeFileSync(join(root, 'att-0123456789abcdef.png'), PNG, {
            mode: 0o600,
        });
        expect(hasSafeAttachmentRoot(root)).toBe(true);
        const result = prepareAttachmentContent(root, 'look', [
            ref('att-0123456789abcdef.png', PNG, 'image', 'image/png'),
        ]);
        expect(result.hasImage).toBe(true);
        expect(result.content).toEqual([
            { type: 'text', text: 'look' },
            {
                type: 'image',
                mimeType: 'image/png',
                data: PNG.toString('base64'),
            },
        ]);
    });

    it('adds a JSON-quoted path for an ordinary file without inlining bytes', () => {
        const root = rootDir();
        const bytes = Buffer.from([0, 1, 2, 255]);
        writeFileSync(join(root, 'att-0123456789abcdef.bin'), bytes, {
            mode: 0o600,
        });
        const result = prepareAttachmentContent(root, '', [
            ref(
                'att-0123456789abcdef.bin',
                bytes,
                'file',
                'application/octet-stream',
            ),
        ]);
        expect(result.hasImage).toBe(false);
        expect(result.content).toEqual([
            { type: 'text', text: '' },
            {
                type: 'text',
                text: `Attached file path (JSON-quoted): ${JSON.stringify(join(root, 'att-0123456789abcdef.bin'))}`,
            },
        ]);
    });

    it('rejects changed bytes and path traversal', () => {
        const root = rootDir();
        writeFileSync(
            join(root, 'att-0123456789abcdef.png'),
            Buffer.from('changed'),
            { mode: 0o600 },
        );
        expect(() =>
            prepareAttachmentContent(root, '', [
                ref('att-0123456789abcdef.png', PNG, 'image', 'image/png'),
            ]),
        ).toThrow('invalid-item');
        expect(() =>
            prepareAttachmentContent(root, '', [
                {
                    ...ref(
                        'att-0123456789abcdef.png',
                        PNG,
                        'image',
                        'image/png',
                    ),
                    basename: '../escape.png',
                },
            ]),
        ).toThrow('invalid-item');
    });

    it.skipIf(process.platform === 'win32')(
        'rejects symlink handoff entries',
        () => {
            const root = rootDir();
            const target = join(root, 'target');
            writeFileSync(target, PNG);
            symlinkSync(target, join(root, 'att-0123456789abcdef.png'));
            expect(() =>
                prepareAttachmentContent(root, '', [
                    ref('att-0123456789abcdef.png', PNG, 'image', 'image/png'),
                ]),
            ).toThrow();
        },
    );

    it('rejects a missing or non-directory root', () => {
        const root = rootDir();
        const file = join(root, 'file');
        writeFileSync(file, 'x');
        expect(hasSafeAttachmentRoot(file)).toBe(false);
    });
});
