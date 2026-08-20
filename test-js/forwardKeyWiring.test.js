import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const terminalJsSrc = readFileSync(
    path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'web',
        'terminal.js',
    ),
    'utf8',
);

// Source-level wiring assertions for _forwardKeyToPty's callers. jsdom can't
// host xterm's custom key handler or the mobile focus yank, so we pin the
// call sites instead (house pattern: nonDirectKeyRedirect.test.js).

describe('non-direct control-key forwarding (terminal focused)', () => {
    it('forwards via _forwardKeyToPty upstream of the printable redirect', () => {
        const fwd = terminalJsSrc.indexOf('this._forwardKeyToPty(e, tabInfo)');
        const redirect = terminalJsSrc.indexOf(
            '// In non-direct mode: redirect printable keystrokes',
        );
        expect(fwd).toBeGreaterThan(-1);
        expect(redirect).toBeGreaterThan(-1);
        expect(fwd).toBeLessThan(redirect);
    });

    it('gates on keydown and non-direct mode only — no emptiness gate', () => {
        const start = terminalJsSrc.indexOf(
            'this._forwardKeyToPty(e, tabInfo)',
        );
        const branch = terminalJsSrc.slice(
            terminalJsSrc.lastIndexOf('if (', start),
            start,
        );
        expect(branch).toContain('!tabInfo.directMode');
        expect(branch).toContain("e.type === 'keydown'");
        expect(branch).not.toContain('value');
    });
});

describe('mobile key fallback wiring', () => {
    function mobileBlock() {
        const start = terminalJsSrc.indexOf(
            '// Mobile arrow-key capture fallback.',
        );
        expect(
            start,
            'mobile fallback marker comment not found',
        ).toBeGreaterThan(-1);
        const end = terminalJsSrc.indexOf('});', start);
        return terminalJsSrc.slice(start, end);
    }

    it('routes through the shared _forwardKeyToPty map', () => {
        expect(mobileBlock()).toContain('this._forwardKeyToPty(e, activeTab)');
    });

    it('skips keys another handler already consumed', () => {
        expect(mobileBlock()).toContain('if (e.defaultPrevented) return;');
    });

    it('skips keys typed into other editable elements', () => {
        expect(mobileBlock()).toContain('t.isContentEditable');
    });

    it('keeps the private mobileKeys map deleted', () => {
        expect(terminalJsSrc).not.toContain('mobileKeys');
    });
});
