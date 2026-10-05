import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { ACCENT_COLORS } from '../web/theme.js';

it('native Phi client uses every canonical desktop/web accent', () => {
    const output = execFileSync(
        'go',
        [
            'test',
            './internal/phic',
            '-run',
            '^TestThemeOracleInput$',
            '-count=1',
            '-v',
        ],
        { encoding: 'utf8', timeout: 60000 },
    );
    const line = output
        .split('\n')
        .find((value) => value.includes('PHIC_PALETTE '));
    const native = JSON.parse(line.slice(line.indexOf('PHIC_PALETTE ') + 13));
    expect(native).toEqual(
        Object.fromEntries(
            Object.entries(ACCENT_COLORS).map(([key, value]) => [
                key,
                value.accent.slice(1),
            ]),
        ),
    );
}, 60000);
