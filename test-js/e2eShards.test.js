import { describe, expect, it } from 'vitest';
import {
    assignShards,
    balancedEntries,
    checkManifests,
    durationByKey,
    parseListedEntries,
    parseListedIds,
} from '../scripts/e2e-shards.mjs';

const listOutput = [
    'Listing tests:',
    '  alpha.spec.ts:20:1 › an unrelated save never persists font sizes',
    '  beta.spec.ts:212:9 › desktop › paste: bytes, recovery, and no-retry',
    '  beta.spec.ts:212:9 › mobile touch › paste: bytes, recovery, and no-retry',
    'Total: 3 tests in 2 files',
    '',
].join('\n');

describe('e2e shard listing parser', () => {
    it('drops the header, the total, and line:column from the id', () => {
        expect(parseListedIds(listOutput)).toEqual([
            'alpha.spec.ts › an unrelated save never persists font sizes',
            'beta.spec.ts › desktop › paste: bytes, recovery, and no-retry',
            'beta.spec.ts › mobile touch › paste: bytes, recovery, and no-retry',
        ]);
    });

    it('keeps the file:line:column key for duration joins', () => {
        const entries = parseListedEntries(listOutput);
        expect(entries.map((entry) => entry.key)).toEqual([
            'alpha.spec.ts:20:1',
            'beta.spec.ts:212:9',
            'beta.spec.ts:212:9',
        ]);
        expect(entries.map((entry) => entry.file)).toEqual([
            'alpha.spec.ts',
            'beta.spec.ts',
            'beta.spec.ts',
        ]);
    });

    it('rejects a line it cannot attribute', () => {
        expect(() => parseListedIds('something else entirely\n')).toThrow();
    });
});

describe('e2e shard durations', () => {
    it('keys durations by file:line:column across nested suites', () => {
        const report = {
            suites: [
                {
                    specs: [
                        { file: 'a.spec.ts', line: 1, column: 2, tests: [] },
                    ],
                    suites: [
                        {
                            specs: [
                                {
                                    file: 'a.spec.ts',
                                    line: 1,
                                    column: 2,
                                    tests: [
                                        {
                                            results: [
                                                { duration: 10 },
                                                { duration: 5 },
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        };
        expect(durationByKey(report).get('a.spec.ts:1:2')).toBe(15);
    });

    it('splits one key across the ids that share it', () => {
        const listed = parseListedEntries(listOutput);
        const durations = new Map([
            ['alpha.spec.ts:20:1', 30],
            ['beta.spec.ts:212:9', 60],
        ]);
        expect(balancedEntries(listed, durations)).toEqual([
            {
                id: 'alpha.spec.ts › an unrelated save never persists font sizes',
                file: 'alpha.spec.ts',
                duration: 30,
            },
            {
                id: 'beta.spec.ts › desktop › paste: bytes, recovery, and no-retry',
                file: 'beta.spec.ts',
                duration: 30,
            },
            {
                id: 'beta.spec.ts › mobile touch › paste: bytes, recovery, and no-retry',
                file: 'beta.spec.ts',
                duration: 30,
            },
        ]);
    });
});

describe('e2e shard assignment', () => {
    const entries = [
        { id: 'heavy.spec.ts › one', file: 'heavy.spec.ts', duration: 100 },
        { id: 'light.spec.ts › one', file: 'light.spec.ts', duration: 1 },
        { id: 'light.spec.ts › two', file: 'light.spec.ts', duration: 1 },
    ];

    it('is deterministic and keeps every id exactly once', () => {
        const first = assignShards(entries, 2);
        const second = assignShards(entries, 2);
        expect(first).toEqual(second);
        expect(first.flat().sort()).toEqual(
            entries.map((entry) => entry.id).sort(),
        );
    });

    it('isolates the heaviest file in an empty suite', () => {
        expect(assignShards(entries, 2)).toEqual([
            ['heavy.spec.ts › one'],
            ['light.spec.ts › one', 'light.spec.ts › two'],
        ]);
    });

    it('keeps every test of one file on the same shard', () => {
        const split = [
            { id: 'a.spec.ts › one', file: 'a.spec.ts', duration: 50 },
            { id: 'a.spec.ts › two', file: 'a.spec.ts', duration: 50 },
            { id: 'b.spec.ts › one', file: 'b.spec.ts', duration: 40 },
            { id: 'b.spec.ts › two', file: 'b.spec.ts', duration: 40 },
        ];
        for (const shard of assignShards(split, 2)) {
            const files = new Set(shard.map((id) => id.split(' › ')[0]));
            expect(files.size).toBe(1);
        }
    });
});

describe('e2e shard coverage check', () => {
    const listed = ['a.spec.ts › one', 'a.spec.ts › two', 'b.spec.ts › three'];

    it('accepts exact disjoint coverage', () => {
        expect(
            checkManifests(
                [['a.spec.ts › one'], ['a.spec.ts › two', 'b.spec.ts › three']],
                listed,
            ),
        ).toEqual({ missing: [], unknown: [], duplicates: [] });
    });

    it('reports a test that no shard lists', () => {
        const result = checkManifests(
            [['a.spec.ts › one'], ['a.spec.ts › two']],
            listed,
        );
        expect(result.missing).toEqual(['b.spec.ts › three']);
        expect(result.unknown).toEqual([]);
        expect(result.duplicates).toEqual([]);
    });

    it('reports an id the suite no longer has', () => {
        const result = checkManifests(
            [
                ['a.spec.ts › one', 'gone.spec.ts › stale'],
                ['a.spec.ts › two', 'b.spec.ts › three'],
            ],
            listed,
        );
        expect(result.unknown).toEqual(['gone.spec.ts › stale']);
    });

    it('reports an id listed twice, in one shard or across two', () => {
        const result = checkManifests(
            [
                ['a.spec.ts › one', 'a.spec.ts › one'],
                ['a.spec.ts › two', 'b.spec.ts › three'],
            ],
            listed,
        );
        expect(result.duplicates).toEqual(['a.spec.ts › one']);
    });
});
