// Congressional toast discipline — structural half.
//
// THE LAW: no new toast without congress and an election.
//   1. DEBATE — register a kebab-case key with a >=24-char justification
//      in web-src/toast-registry.ts. Answer in the justification: why a
//      popup, and not the drawer / status bar / nothing?
//   2. VOTE — pass `key:` at the showToast call site, then bump
//      EXPECTED_TOAST_CALL_SITES below. That one-line bump IS the vote:
//      it is reviewable, revertable, and fails CI until cast.
//   3. TERM LIMIT — same key (or same unkeyed title+message) twice
//      within 2s is dropped in prod and THROWS in tests (see the global
//      setup + toastRateLimit.test.js).
//
// This file enforces (1) structurally: the call-site count is frozen,
// every top-level `key:` inside a showToast(...) span must be on the
// ballot, and the popup anchors bottom-left, notification-style.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { isRegisteredToastKey, TOAST_REGISTRY } from '../web/toast-registry.js';

// THE VOTE. Bump this if and only if you registered keys for the new
// call site(s) in web-src/toast-registry.ts. The diff reviewer is congress.
const EXPECTED_TOAST_CALL_SITES = 162;

const CONGRESS_MESSAGE = [
    'Toast call-site count changed.',
    'To add a toast: (1) register a key with justification in',
    'web-src/toast-registry.ts, (2) pass key: at the call site,',
    '(3) bump EXPECTED_TOAST_CALL_SITES here. To remove one: delete',
    'the call site and lower the count. No silent toasts.',
].join(' ');

function webSrcFiles() {
    return readdirSync('web-src')
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `web-src/${f}`);
}

// Blank out strings/comments (keeping offsets) so structural scanning
// never sees through them. Handles ', ", ` with ${} nesting, //, /* */,
// and regex literals (distinguished from division by the standard
// preceding-token heuristic).
function stripStringsAndComments(src) {
    let out = '';
    const stack = []; // {q} string frames, {expr:depth} ${} frames
    const top = () => stack[stack.length - 1];
    const blank = (c) => {
        out += c === '\n' ? '\n' : ' ';
    };
    const lineComment = (i) => {
        let j = i;
        while (j < src.length && src[j] !== '\n') {
            blank(src[j]);
            j += 1;
        }
        return j;
    };
    const blockComment = (i) => {
        let j = i;
        while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) {
            blank(src[j]);
            j += 1;
        }
        blank('*');
        blank('/');
        return j + 2;
    };
    let i = 0;
    let prevSig = ''; // last significant (non-blank) code char emitted
    const pushCode = (c) => {
        out += c;
        if (c !== ' ' && c !== '\n' && c !== '\t' && c !== '\r') prevSig = c;
    };
    // A `/` opens a regex literal (not division/comment) when the previous
    // significant token cannot end an expression.
    const REGEX_KEYWORDS = new Set([
        'return',
        'typeof',
        'instanceof',
        'in',
        'of',
        'new',
        'delete',
        'void',
        'throw',
        'case',
        'do',
        'else',
        'yield',
        'await',
    ]);
    const slashOpensRegex = () => {
        if (prevSig === '') return true;
        if (/[\w$]/.test(prevSig)) {
            // Walk back the identifier from the emitted output.
            let j = out.length - 1;
            while (j >= 0 && /[\w$]/.test(out[j])) j -= 1;
            return REGEX_KEYWORDS.has(out.slice(j + 1));
        }
        return '([{,=:!&|?;+-*~^%<>'.includes(prevSig);
    };
    const consumeRegex = (from) => {
        // from is the index of the opening '/'; blank through flags.
        let j = from;
        blank(src[j]);
        j += 1;
        let inClass = false;
        while (j < src.length) {
            const c = src[j];
            if (c === '\\') {
                blank(c);
                blank(src[j + 1] ?? '');
                j += 2;
                continue;
            }
            if (c === '\n') {
                blank(c);
                j += 1;
                break; // unterminated; bail like the engine would
            }
            if (c === '[') inClass = true;
            if (c === ']') inClass = false;
            blank(c);
            j += 1;
            if (c === '/' && !inClass) break;
        }
        while (j < src.length && /[a-z]/i.test(src[j])) {
            blank(src[j]);
            j += 1;
        }
        return j;
    };
    while (i < src.length) {
        const c = src[i];
        const d = src[i + 1];
        const t = top();
        if (!t || t.expr !== undefined) {
            // Code (top level or inside ${}).
            if (c === '/' && d !== '/' && d !== '*' && slashOpensRegex()) {
                i = consumeRegex(i);
                prevSig = '/';
                continue;
            }
            if (c === '/' && d === '/') {
                i = lineComment(i);
                continue;
            }
            if (c === '/' && d === '*') {
                i = blockComment(i);
                continue;
            }
            if (c === "'" || c === '"' || c === '`') {
                stack.push({ q: c });
                blank(c);
                i += 1;
                continue;
            }
            if (t && t.expr !== undefined) {
                if (c === '{') t.expr += 1;
                if (c === '}') {
                    t.expr -= 1;
                    if (t.expr === 0) {
                        stack.pop();
                        blank(c);
                        i += 1;
                        continue;
                    }
                }
            }
            pushCode(c);
            i += 1;
            continue;
        }
        // Inside a string.
        if (c === '\\') {
            blank(c);
            blank(d ?? '');
            i += 2;
            continue;
        }
        if (t.q === '`' && c === '$' && d === '{') {
            blank(c);
            blank(d);
            i += 2;
            stack.push({ expr: 1 });
            continue;
        }
        if (c === t.q) {
            stack.pop();
            blank(c);
            i += 1;
            continue;
        }
        blank(c);
        i += 1;
    }
    return out;
}

// Find showToast(...) call spans via paren depth on sanitized source.
// Method/interface declarations are filtered by the caller (first param
// `message:`), so this returns every candidate span.
function showToastSpans(sanitized) {
    const spans = [];
    const re = /(?<![\w$])showToast\s*(?:\?\.\s*)?\(/g;
    for (const m of sanitized.matchAll(re)) {
        let depth = 0;
        let j = m.index + m[0].length - 1; // at '('
        for (; j < sanitized.length; j += 1) {
            if (sanitized[j] === '(') depth += 1;
            else if (sanitized[j] === ')') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        spans.push(sanitized.slice(m.index, j + 1));
    }
    return spans;
}

const isDeclaration = (span) => /showToast\(\s*message\s*:/.test(span);

// Top-level `key:` of the options object only (depth 2 relative to the
// call paren). Nested objects (action callbacks etc.) don't count.
function spanKey(span) {
    const start = span.indexOf('(');
    let depth = 0;
    for (let i = start; i < span.length; i += 1) {
        const c = span[i];
        if (c === '(' || c === '{' || c === '[') depth += 1;
        else if (c === ')' || c === '}' || c === ']') depth -= 1;
        else if (depth === 2) {
            const rest = span.slice(i);
            if (
                /^key\s*:/.test(rest) &&
                /[,{(]\s*$/.test(span.slice(start + 1, i))
            ) {
                const vm = rest.match(
                    /^key\s*:\s*'([^']+)'|^key\s*:\s*"([^"]+)"/,
                );
                if (vm) return vm[1] ?? vm[2];
            }
        }
    }
    return null;
}

function callSites() {
    const sites = [];
    for (const file of webSrcFiles()) {
        const spans = showToastSpans(
            stripStringsAndComments(readFileSync(file, 'utf8')),
        );
        for (const span of spans) {
            if (!isDeclaration(span)) sites.push({ file, span });
        }
    }
    return sites;
}

describe('toast discipline: frozen call-site count (the vote)', () => {
    it('freezes the number of showToast emission sites', () => {
        const sites = callSites();
        expect(
            sites.length,
            `${CONGRESS_MESSAGE} (found ${sites.length})`,
        ).toBe(EXPECTED_TOAST_CALL_SITES);
    });

    it('every key: at a call site is on the ballot', () => {
        const unregistered = [];
        for (const { file, span } of callSites()) {
            const key = spanKey(span);
            if (key !== null && !isRegisteredToastKey(key)) {
                unregistered.push(`${file}: ${key}`);
            }
        }
        expect(
            unregistered,
            `Unregistered toast keys (register in web-src/toast-registry.ts first): ${unregistered.join(', ')}`,
        ).toEqual([]);
    });
});

describe('toast discipline: the ballot itself', () => {
    it('every registered key is kebab-case with a real justification', () => {
        for (const [key, justification] of Object.entries(TOAST_REGISTRY)) {
            expect(key, `toast key "${key}" must be kebab-case`).toMatch(
                /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
            );
            expect(
                typeof justification === 'string' &&
                    justification.trim().length >= 24,
                `toast key "${key}" needs a >=24-char justification (congressional record)`,
            ).toBe(true);
        }
    });
});

describe('toast discipline: bottom-left, notification-style', () => {
    const css = readFileSync('web/style.css', 'utf8');
    const baseContainer = (() => {
        const start = css.indexOf('.toast-container {');
        return css.slice(start, css.indexOf('}', start) + 1);
    })();
    const baseToast = (() => {
        const start = css.indexOf('.toast {');
        return css.slice(start, css.indexOf('}', start) + 1);
    })();

    it('anchors the container bottom-left, never top-right', () => {
        expect(
            /bottom\s*:/.test(baseContainer),
            '.toast-container must set bottom:',
        ).toBe(true);
        expect(
            /left\s*:/.test(baseContainer),
            '.toast-container must set left:',
        ).toBe(true);
        expect(
            /top\s*:/.test(baseContainer),
            '.toast-container must NOT set top: (top-right is forbidden)',
        ).toBe(false);
        expect(
            /right\s*:/.test(baseContainer),
            '.toast-container must NOT set right: (top-right is forbidden)',
        ).toBe(false);
    });

    it('slides in from the left edge', () => {
        expect(
            baseToast.includes('translateX(-12px)'),
            '.toast must enter with translateX(-12px)',
        ).toBe(true);
    });
});
