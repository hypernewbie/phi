import { describe, expect, it } from 'vitest';
import { createHeadlessSandbox } from './_xtermHeadless.js';
import {
    archiveScrollbackFor,
    createTerminalArchiveScanner,
} from '../web/terminal-search-core.js';

const encoder = new TextEncoder();

function createScanner({ cols = 16, rows = 3, scrollback = 8, query }) {
    const { Terminal } = createHeadlessSandbox();
    const terminal = new Terminal({
        cols,
        rows,
        scrollback,
        allowProposedApi: true,
        disableStdin: true,
    });
    return {
        terminal,
        scanner: createTerminalArchiveScanner(terminal, query),
    };
}

describe('terminal archive scanner', () => {
    it('finds a literal match across soft wraps and one-byte UTF-8 chunks', async () => {
        const { terminal, scanner } = createScanner({
            cols: 7,
            query: 'ARCHIVE-MATCH-037',
        });
        try {
            const bytes = encoder.encode(
                '\x1b]0;HIDDEN-TITLE\x07\x1b[31mbefore 🐈 ARCHIVE-MATCH-037 after\x1b[0m\r\n',
            );
            for (let offset = 0; offset < bytes.length; offset++)
                await scanner.write(bytes.subarray(offset, offset + 1));
            scanner.finish();
            const matches = scanner.takeMatches();
            expect(matches).toHaveLength(1);
            expect(matches[0].snippet).toContain('ARCHIVE-MATCH-037');
        } finally {
            scanner.dispose();
            terminal.dispose();
        }
    });

    it('finds a match in the retained tail of a wrapped row after scrollback eviction', async () => {
        const { terminal, scanner } = createScanner({
            cols: 7,
            rows: 2,
            scrollback: 2,
            query: 'WRAPPED-TAIL-MATCH',
        });
        try {
            await scanner.write(
                encoder.encode(`${'x'.repeat(80)}WRAPPED-TAIL-MATCH`),
            );
            scanner.finish();
            expect(scanner.takeMatches()).toEqual([
                expect.objectContaining({
                    snippet: expect.stringContaining('WRAPPED-TAIL-MATCH'),
                }),
            ]);
        } finally {
            scanner.dispose();
            terminal.dispose();
        }
    });

    it('uses literal Unicode case-insensitive matching', async () => {
        for (const [query, text] of [
            ['A.B', 'a.b'],
            ['é', 'É'],
            ['🐈', '🐈'],
        ]) {
            const { terminal, scanner } = createScanner({
                cols: 24,
                query,
            });
            try {
                await scanner.write(encoder.encode(`value ${text} tail\r\n`));
                scanner.finish();
                expect(scanner.takeMatches()).toHaveLength(1);
            } finally {
                scanner.dispose();
                terminal.dispose();
            }
        }
    });

    it('keeps repeated identical rows distinct after parser scrollback eviction', async () => {
        const { terminal, scanner } = createScanner({
            cols: 24,
            rows: 2,
            scrollback: 1,
            query: 'REPEATED-ARCHIVE-ROW',
        });
        try {
            const source = [
                'REPEATED-ARCHIVE-ROW',
                ...Array.from({ length: 40 }, (_, index) => `padding-${index}`),
                'REPEATED-ARCHIVE-ROW',
            ].join('\r\n');
            await scanner.write(encoder.encode(source));
            scanner.finish();
            const matches = scanner.takeMatches();
            expect(matches).toHaveLength(2);
            expect(matches[0].id).not.toBe(matches[1].id);
        } finally {
            scanner.dispose();
            terminal.dispose();
        }
    });

    it('keeps a split match across feed and resize/reflow boundaries', async () => {
        const { terminal, scanner } = createScanner({
            cols: 7,
            rows: 3,
            query: 'ARCHIVE-REFLOW-MATCH',
        });
        try {
            await scanner.write(encoder.encode('prefix ARCHIVE-'));
            scanner.resize(14, 3);
            await scanner.write(encoder.encode('REFLOW-MATCH suffix\r\n'));
            scanner.finish();
            expect(scanner.takeMatches()).toEqual([
                expect.objectContaining({
                    snippet: expect.stringContaining('ARCHIVE-REFLOW-MATCH'),
                }),
            ]);
        } finally {
            scanner.dispose();
            terminal.dispose();
        }
    });

    it('finds the final unterminated row and excludes OSC metadata', async () => {
        const { terminal, scanner } = createScanner({
            cols: 32,
            query: 'VISIBLE-TAIL',
        });
        try {
            await scanner.write(
                encoder.encode('\x1b]0;HIDDEN-TITLE\x07VISIBLE-TAIL'),
            );
            scanner.finish();
            expect(scanner.takeMatches()).toEqual([
                expect.objectContaining({
                    snippet: expect.stringContaining('VISIBLE-TAIL'),
                }),
            ]);
            expect(scanner.takeMatches()).toEqual([]);
        } finally {
            scanner.dispose();
            terminal.dispose();
        }
    });

    it('caps retained matches at 200 but continues observing later rows', async () => {
        const { terminal, scanner } = createScanner({
            cols: 32,
            rows: 3,
            scrollback: 4,
            query: 'ARCHIVE-HIT',
        });
        try {
            const source = Array.from(
                { length: 240 },
                (_, index) =>
                    `ARCHIVE-HIT-${index.toString().padStart(3, '0')}`,
            ).join('\r\n');
            await scanner.write(encoder.encode(source));
            scanner.finish();
            expect(scanner.takeMatches()).toHaveLength(200);
            expect(scanner.capped).toBe(true);
        } finally {
            scanner.dispose();
            terminal.dispose();
        }
    });

    it('bounds scrollback by both row count and parser cell budget', () => {
        expect(archiveScrollbackFor(80, 24)).toBe(10_000);
        expect(archiveScrollbackFor(2_000, 500)).toBe(1_000);
        expect(() => archiveScrollbackFor(65_535, 31)).toThrow(
            'parser geometry exceeds cell budget',
        );
    });
});
