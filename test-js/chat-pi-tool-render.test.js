// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    renderToolExecution,
    validatedToolDiff,
} from '../web/chat-pi/tool-render.js';

const JS_DIFF_SOURCE = readFileSync(
    join(process.cwd(), 'web', 'vendor', 'jsdiff.min.js'),
    'utf8',
);

function loadJsDiff() {
    const sandbox = {
        self: undefined,
        globalThis: undefined,
        Promise,
        Set,
        Map,
        WeakMap,
        WeakSet,
        Symbol,
        Uint8Array,
        Int32Array,
        ArrayBuffer,
        Object,
        Array,
        JSON,
        Math,
        Date,
        Error,
        TypeError,
        RangeError,
        console: { log() {}, warn() {}, error() {} },
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    const fn = new Function(
        'self',
        'globalThis',
        `${JS_DIFF_SOURCE}\nreturn globalThis;`,
    );
    return fn(sandbox, sandbox).Diff;
}

function renderEdit({
    diff,
    output = '<fallback-output>',
    status = 'success',
} = {}) {
    return renderToolExecution({
        id: 'edit-1',
        name: 'edit',
        args: { file_path: '/work/example.ts' },
        status,
        output,
        ...(diff === undefined ? {} : { diff }),
    });
}

beforeAll(() => {
    window.Diff = loadJsDiff();
});

afterAll(() => {
    delete window.Diff;
});

describe('Pi TUI-style edit diff rendering', () => {
    it('renders added, removed, and context display rows', () => {
        const tool = renderEdit({
            diff: '+1 added\n 2 context\n-3 removed',
        });
        const rows = [...tool.querySelectorAll('.tool-diff > div')];
        expect(rows.map((row) => row.className)).toEqual([
            'diff-added',
            'diff-context',
            'diff-removed',
        ]);
        expect(rows.map((row) => row.textContent)).toEqual([
            '+1 added',
            ' 2 context',
            '-3 removed',
        ]);
    });

    it('expands tabs to three spaces in display rows', () => {
        const tool = renderEdit({ diff: '+7 \tconst value = true' });
        expect(tool.querySelector('.diff-added').textContent).toBe(
            '+7    const value = true',
        );
    });

    it('highlights one-line replacement words without highlighting indentation', () => {
        const tool = renderEdit({
            diff: '-10   const old = value\n+10   const new = value',
        });
        const removed = tool.querySelector('.diff-removed');
        const added = tool.querySelector('.diff-added');
        expect(removed.textContent).toBe('-10   const old = value');
        expect(added.textContent).toBe('+10   const new = value');
        expect(
            [...removed.querySelectorAll('.diff-word-change')].map(
                (span) => span.textContent,
            ),
        ).toEqual(['old']);
        expect(
            [...added.querySelectorAll('.diff-word-change')].map(
                (span) => span.textContent,
            ),
        ).toEqual(['new']);
        expect(
            removed.querySelector('.diff-word-change').textContent,
        ).not.toMatch(/^\s/);
        expect(
            added.querySelector('.diff-word-change').textContent,
        ).not.toMatch(/^\s/);
    });

    it('does not word-highlight multi-line replacement groups', () => {
        const tool = renderEdit({
            diff: '-1 old one\n-2 old two\n+1 new one\n+2 new two',
        });
        expect(tool.querySelectorAll('.diff-removed')).toHaveLength(2);
        expect(tool.querySelectorAll('.diff-added')).toHaveLength(2);
        expect(tool.querySelectorAll('.diff-word-change')).toHaveLength(0);
    });

    it('keeps malicious diff text literal in the DOM', () => {
        const malicious = '<img src=x onerror="bad()">';
        const tool = renderEdit({ diff: `+1 ${malicious}` });
        expect(tool.querySelector('img')).toBeNull();
        expect(tool.textContent).toContain(malicious);
        expect(tool.innerHTML).not.toContain('<img');
    });

    it('falls back to complete rows when the jsdiff global is unavailable', () => {
        const saved = window.Diff;
        window.Diff = undefined;
        try {
            const tool = renderEdit({
                diff: '-1 old\n+1 new',
            });
            expect(tool.querySelectorAll('.diff-word-change')).toHaveLength(0);
            expect(tool.querySelector('.diff-removed').textContent).toBe(
                '-1 old',
            );
            expect(tool.querySelector('.diff-added').textContent).toBe(
                '+1 new',
            );
        } finally {
            window.Diff = saved;
        }
    });
});

describe('edit diff validation and safe fallback', () => {
    it('accepts only non-error object details with a string diff', () => {
        expect(
            validatedToolDiff({
                message: { role: 'toolResult', details: { diff: '+1 ok' } },
                isError: false,
            }),
        ).toBe('+1 ok');
        expect(
            validatedToolDiff({
                message: { role: 'toolResult', details: ['+1 bad'] },
                isError: false,
            }),
        ).toBeUndefined();
        expect(
            validatedToolDiff({
                message: { role: 'toolResult', details: { diff: 42 } },
                isError: false,
            }),
        ).toBeUndefined();
        expect(
            validatedToolDiff({
                message: { role: 'toolResult', details: { diff: '+1 bad' } },
                isError: true,
            }),
        ).toBeUndefined();
    });

    it('uses the existing literal pre fallback without valid diff metadata', () => {
        const output = '<script>bad()</script>';
        const missing = renderEdit({ output });
        expect(missing.querySelector('.tool-diff')).toBeNull();
        expect(missing.querySelector('.tool-output pre').textContent).toBe(
            output,
        );
        expect(missing.querySelector('script')).toBeNull();

        const errored = renderEdit({
            diff: '+1 should-not-render',
            output: 'error output',
            status: 'error',
        });
        expect(errored.querySelector('.tool-diff')).toBeNull();
        expect(errored.querySelector('.tool-output pre').textContent).toBe(
            'error output',
        );
    });
});

describe('Pi TUI-style read rendering', () => {
    it('shows path with offset/limit line range and expandable output', () => {
        const tool = renderToolExecution({
            id: 'read-1',
            name: 'read',
            args: {
                file_path: '/Users/example/work/sample.ts',
                offset: 10,
                limit: 5,
            },
            status: 'success',
            output: 'line ten\nline eleven\nline twelve',
        });
        expect(tool.classList.contains('success')).toBe(true);
        expect(tool.id).toBe('tool-call-read-1');
        const header = tool.querySelector('.tool-header');
        expect(header).not.toBeNull();
        expect(header.querySelector('.tool-name').textContent).toBe('read');
        expect(header.querySelector('.tool-path').textContent).toBe(
            '~/work/sample.ts',
        );
        expect(header.querySelector('.line-numbers').textContent).toBe(
            ':10-14',
        );
        expect(tool.querySelector('.tool-output')).not.toBeNull();
        expect(tool.textContent).toContain('line ten');
    });

    it('omits line range and shows only path when offset/limit are absent', () => {
        const tool = renderToolExecution({
            id: 'read-2',
            name: 'read',
            args: { file_path: '/Users/example/work/full.ts' },
            status: 'success',
            output: 'top line',
        });
        const header = tool.querySelector('.tool-header');
        expect(header.querySelector('.tool-path').textContent).toBe(
            '~/work/full.ts',
        );
        expect(header.querySelector('.line-numbers')).toBeNull();
        expect(tool.querySelector('.tool-output')).not.toBeNull();
    });

    it('renders the first 10 lines with the generic expand hint', () => {
        const output = Array.from(
            { length: 15 },
            (_, i) => `line-${i + 1}`,
        ).join('\n');
        const tool = renderToolExecution({
            id: 'read-preview',
            name: 'read',
            args: { file_path: '/Users/example/work/preview.ts' },
            status: 'success',
            output,
        });
        expect(tool.querySelector('.output-preview > div').textContent).toBe(
            'line-1',
        );
        expect(tool.querySelector('.expand-hint').textContent).toBe(
            '... (5 more lines, ↵ to expand)',
        );
    });

    it('toggles expandable generic output from the tool header', () => {
        const output = Array.from(
            { length: 15 },
            (_, i) => `line-${i + 1}`,
        ).join('\n');
        const tool = renderToolExecution({
            id: 'read-toggle',
            name: 'read',
            args: { file_path: '/Users/example/work/toggle.ts' },
            status: 'success',
            output,
        });
        const header = tool.querySelector('.tool-header');
        const expandable = tool.querySelector('.tool-output.expandable');
        header.click();
        expect(expandable.classList.contains('expanded')).toBe(true);
        header.click();
        expect(expandable.classList.contains('expanded')).toBe(false);
    });
});

describe('Pi TUI-style write rendering', () => {
    it('shows the path, the content preview, and the plain result line', () => {
        const tool = renderToolExecution({
            id: 'write-1',
            name: 'write',
            args: {
                file_path: '/Users/example/work/short.ts',
                content: 'console.log("hi");\n',
            },
            status: 'success',
            output: 'wrote 1 line',
        });
        const header = tool.querySelector('.tool-header');
        expect(header.querySelector('.tool-name').textContent).toBe('write');
        expect(header.querySelector('.tool-path').textContent).toBe(
            '~/work/short.ts',
        );
        const toolOutputs = tool.querySelectorAll('.tool-output');
        expect(toolOutputs).toHaveLength(2);
        expect(toolOutputs[0].textContent).toContain('console.log("hi");');
        expect(toolOutputs[1].textContent).toContain('wrote 1 line');
    });

    it('announces a long content preview via a .line-count span', () => {
        const longContent = Array.from(
            { length: 25 },
            (_, i) => `line ${i + 1}`,
        ).join('\n');
        const tool = renderToolExecution({
            id: 'write-2',
            name: 'write',
            args: {
                file_path: '/Users/example/work/big.ts',
                content: longContent,
            },
            status: 'success',
            output: 'wrote 25 lines',
        });
        const header = tool.querySelector('.tool-header');
        expect(header.querySelector('.line-count').textContent).toBe(
            '(25 lines)',
        );
    });
});

describe('Pi TUI-style ls rendering', () => {
    it('shows the directory path, an optional limit tag, and the expandable output', () => {
        const tool = renderToolExecution({
            id: 'ls-1',
            name: 'ls',
            args: { path: '/Users/example/work', limit: 50 },
            status: 'success',
            output: 'a.txt\nb.txt',
        });
        const header = tool.querySelector('.tool-header');
        expect(header.querySelector('.tool-name').textContent).toBe('ls');
        expect(header.querySelector('.tool-path').textContent).toBe('~/work');
        expect(header.querySelector('.line-count').textContent).toBe(
            '(limit 50)',
        );
        expect(tool.querySelector('.tool-output')).not.toBeNull();
        expect(tool.textContent).toContain('a.txt');
    });

    it('falls back to "." when the path arg is an empty string', () => {
        const tool = renderToolExecution({
            id: 'ls-2',
            name: 'ls',
            args: { path: '' },
            status: 'success',
            output: 'c.txt',
        });
        expect(tool.querySelector('.tool-header .tool-path').textContent).toBe(
            '.',
        );
    });

    it('marks an invalid (non-string) path arg with [invalid arg]', () => {
        const tool = renderToolExecution({
            id: 'ls-3',
            name: 'ls',
            args: {},
            status: 'success',
            output: 'c.txt',
        });
        expect(tool.querySelector('.tool-header .tool-error').textContent).toBe(
            '[invalid arg]',
        );
    });
});

describe('Pi TUI-style grep / find rendering', () => {
    it('uses the pattern as the header subject for grep', () => {
        const tool = renderToolExecution({
            id: 'grep-1',
            name: 'grep',
            args: { pattern: 'TODO', path: '/Users/example/work' },
            status: 'success',
            output: 'src/index.ts:1: // TODO',
        });
        const header = tool.querySelector('.tool-header');
        expect(header.querySelector('.tool-name').textContent).toBe('grep');
        expect(header.querySelector('.tool-path').textContent).toBe('TODO');
        expect(tool.querySelector('.tool-output')).not.toBeNull();
    });

    it('falls back to the path when the pattern is missing for grep', () => {
        const tool = renderToolExecution({
            id: 'grep-2',
            name: 'grep',
            args: { path: '/Users/example/work' },
            status: 'success',
            output: 'a.ts:1: var',
        });
        expect(tool.querySelector('.tool-header .tool-path').textContent).toBe(
            '~/work',
        );
    });

    it('uses the pattern as the header subject for find', () => {
        const tool = renderToolExecution({
            id: 'find-1',
            name: 'find',
            args: { pattern: '*.go', path: '/Users/example/work' },
            status: 'success',
            output: 'main.go',
        });
        expect(tool.querySelector('.tool-header .tool-path').textContent).toBe(
            '*.go',
        );
        expect(tool.querySelector('.tool-output')).not.toBeNull();
    });
});

describe('Pi TUI-style generic / unknown tool fallback', () => {
    it('renders mcp with a default header, JSON args, and expandable output', () => {
        const tool = renderToolExecution({
            id: 'mcp-1',
            name: 'mcp',
            args: {
                server: 'fs',
                tool: 'stat',
                arguments: { path: '/Users/example/work/x.ts' },
            },
            status: 'success',
            output: 'mode: file',
        });
        const header = tool.querySelector('.tool-header');
        expect(header.querySelector('.tool-name').textContent).toBe('mcp');
        const argsPre = tool.querySelector('.tool-output pre');
        expect(argsPre).not.toBeNull();
        expect(argsPre.textContent).toContain('"server": "fs"');
        expect(tool.textContent).toContain('mode: file');
        expect(tool.querySelector('img')).toBeNull();
    });

    it('renders an arbitrary custom_tool with the default header, JSON args, and output', () => {
        const tool = renderToolExecution({
            id: 'custom-1',
            name: 'custom_tool',
            args: { payload: '<b>payload</b>' },
            status: 'success',
            output: '<i>result</i>',
        });
        const header = tool.querySelector('.tool-header');
        expect(header.querySelector('.tool-name').textContent).toBe(
            'custom_tool',
        );
        const argsPre = tool.querySelector('.tool-output pre');
        expect(argsPre).not.toBeNull();
        expect(argsPre.textContent).toContain('<b>payload</b>');
        expect(tool.textContent).toContain('<i>result</i>');
        expect(tool.querySelector('b')).toBeNull();
        expect(tool.querySelector('i')).toBeNull();
    });
});

describe('Pi tool-call pending and error states', () => {
    it('renders a pending custom_tool call with running… placeholder when no args are provided', () => {
        const tool = renderToolExecution({
            id: 'pending-custom',
            name: 'custom_tool',
            args: {},
            status: 'pending',
        });
        expect(tool.classList.contains('pending')).toBe(true);
        expect(tool.querySelector('.tool-output').textContent).toBe('running…');
    });

    it('renders an error toolResult with .tool-execution.error and its literal output alongside the args JSON', () => {
        const tool = renderToolExecution({
            id: 'err-custom',
            name: 'custom_tool',
            args: { payload: 'go' },
            status: 'error',
            output: 'custom_tool: invalid payload',
        });
        expect(tool.classList.contains('error')).toBe(true);
        const toolOutputs = tool.querySelectorAll('.tool-output');
        expect(toolOutputs.length).toBeGreaterThanOrEqual(2);
        const combined = Array.from(toolOutputs)
            .map((node) => node.textContent ?? '')
            .join('\n');
        expect(combined).toContain('"payload": "go"');
        expect(combined).toContain('custom_tool: invalid payload');
    });

    it('folds error blocks by default and unfolds on header click', () => {
        const tool = renderToolExecution({
            id: 'err-fold',
            name: 'custom_tool',
            args: { payload: 'go' },
            status: 'error',
            output: 'custom_tool: invalid payload',
        });
        // Folded by default; the outputs stay in the DOM (CSS hides them).
        expect(tool.classList.contains('folded')).toBe(true);
        const combined = Array.from(tool.querySelectorAll('.tool-output'))
            .map((node) => node.textContent ?? '')
            .join('\n');
        expect(combined).toContain('custom_tool: invalid payload');

        const header = tool.querySelector('.tool-header');
        header.click();
        expect(tool.classList.contains('folded')).toBe(false);
        header.click();
        expect(tool.classList.contains('folded')).toBe(true);
    });

    it('does not fold success or pending blocks', () => {
        const ok = renderToolExecution({
            id: 'ok-nofold',
            name: 'read',
            args: { file_path: '/a.ts' },
            status: 'success',
            output: 'line1\nline2',
        });
        expect(ok.classList.contains('folded')).toBe(false);
        const pending = renderToolExecution({
            id: 'pend-nofold',
            name: 'read',
            args: { file_path: '/a.ts' },
            status: 'pending',
        });
        expect(pending.classList.contains('folded')).toBe(false);
    });
});
