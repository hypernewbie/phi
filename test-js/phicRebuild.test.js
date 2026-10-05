import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import {
    Terminal,
    firstDifference,
    parse,
    terminalState,
} from './_terminalOracle.js';

let rebuild;
beforeAll(() => {
    const output = execFileSync(
        'go',
        [
            'test',
            './internal/phic',
            '-run',
            '^TestRebuildOracleInput$',
            '-count=1',
            '-v',
        ],
        { encoding: 'utf8', timeout: 60000 },
    );
    const line = output
        .split('\n')
        .find((value) => value.includes('PHIC_REBUILD '));
    rebuild = JSON.parse(line.slice(line.indexOf('PHIC_REBUILD ') + 13));
}, 60000);

function view(term) {
    const state = terminalState(term);
    state.lines = state.lines.slice(state.baseY, state.baseY + term.rows);
    delete state.baseY; // Native scrollback contains inline menus and replay.
    return state;
}

describe('phic recording rebuild, not native-buffer snapshotting', () => {
    it.each([
        'normal',
        'alternate',
        'both buffers',
        'custom tabs and scroll region',
        'keyboard',
        'query',
    ])('returns from repeated inline views: %s', async (name) => {
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
        const replies = [];
        const listener = candidate.onData((data) => replies.push(data));
        try {
            await parse(reference, rebuild.baseline + rebuild.fixtures[name]);
            await parse(candidate, rebuild.baseline + rebuild.fixtures[name]);
            replies.length = 0;
            for (let n = 0; n < 3; n++) {
                await parse(
                    candidate,
                    rebuild.menu + rebuild.baseline + rebuild.replay[name],
                );
                expect(firstDifference(view(reference), view(candidate))).toBe(
                    null,
                );
                expect(replies).toEqual([]);
            }
            // Test parser/cursor/style continuation, not just the original text.
            await parse(reference, 'FUTURE\tTEXT\r\nNEXT');
            await parse(candidate, 'FUTURE\tTEXT\r\nNEXT');
            expect(firstDifference(view(reference), view(candidate))).toBe(
                null,
            );
            if (name === 'both buffers') {
                await parse(reference, '\x1b[?1049l');
                await parse(candidate, '\x1b[?1049l');
                expect(firstDifference(view(reference), view(candidate))).toBe(
                    null,
                );
            }
        } finally {
            listener.dispose();
            reference.dispose();
            candidate.dispose();
        }
    });
});
