import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { Terminal, parse, terminalState } from './_terminalOracle.js';

let operations;
beforeAll(() => {
    const output = execFileSync(
        'go',
        [
            'test',
            './internal/termproof',
            '-run',
            '^TestCandidateOracleInput$',
            '-count=1',
            '-v',
        ],
        { encoding: 'utf8', timeout: 60000 },
    );
    const line = output
        .split('\n')
        .find((value) => value.includes('PHIC_SCREEN_OPERATIONS '));
    operations = JSON.parse(
        line.slice(line.indexOf('PHIC_SCREEN_OPERATIONS ') + 23),
    );
}, 60000);

// These are measured counterexamples, not a claimed passing compatibility
// matrix. Production must not use this candidate to enable live overlays.
describe('phic native-buffer candidate is not a general screen restoration', () => {
    it.each([
        ['currently active alternate screen', '\x1b[?1049hALT CONTENT', ''],
    ])('%s', async (_name, prefix, future) => {
        const reference = new Terminal({
            cols: 40,
            rows: 8,
            allowProposedApi: true,
        });
        const candidate = new Terminal({
            cols: 40,
            rows: 8,
            allowProposedApi: true,
        });
        try {
            await parse(reference, prefix + future);
            await parse(
                candidate,
                prefix +
                    operations.open +
                    'MENU CONTENT' +
                    operations.close +
                    future,
            );
            expect(terminalState(candidate)).not.toEqual(
                terminalState(reference),
            );
            expect(reference.buffer.active.type).toBe('alternate');
        } finally {
            reference.dispose();
            candidate.dispose();
        }
    });

    it('replaying historical alternate output at current width changes the screen', async () => {
        const reference = new Terminal({
            cols: 8,
            rows: 4,
            allowProposedApi: true,
        });
        const replay = new Terminal({
            cols: 12,
            rows: 4,
            allowProposedApi: true,
        });
        try {
            await parse(reference, '\x1b[?1049hABCDEFGHIJKLMN');
            reference.resize(12, 4);
            await parse(reference, 'X');
            await parse(replay, '\x1b[?1049hABCDEFGHIJKLMNX');
            expect(terminalState(replay)).not.toEqual(terminalState(reference));
        } finally {
            reference.dispose();
            replay.dispose();
        }
    });

    it('a nonce mode query fences the parser without changing screen state', async () => {
        const term = new Terminal({
            cols: 40,
            rows: 8,
            allowProposedApi: true,
        });
        const replies = [];
        const listener = term.onData((data) => replies.push(data));
        try {
            await parse(term, '\x1b[?1049h\x1b[31mCONTENT\x1b[2;3H');
            const before = terminalState(term);
            await parse(term, operations.barrier_request);
            expect(replies).toEqual([operations.barrier_reply]);
            expect(terminalState(term)).toEqual(before);
        } finally {
            listener.dispose();
            term.dispose();
        }
    });

    it('replaying an old query produces another input reply', async () => {
        const term = new Terminal({
            cols: 40,
            rows: 8,
            allowProposedApi: true,
        });
        const replies = [];
        const listener = term.onData((data) => replies.push(data));
        try {
            await parse(term, '\x1b[6n');
            await parse(term, '\x1b[6n');
            expect(replies).toEqual(['\x1b[1;1R', '\x1b[1;1R']);
        } finally {
            listener.dispose();
            term.dispose();
        }
    });
});
