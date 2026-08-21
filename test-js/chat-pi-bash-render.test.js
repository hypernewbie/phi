// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderBashExecution } from '../web/chat-pi/bash-render.js';

describe('renderBashExecution', () => {
    it('produces a pending block with command + running hint', () => {
        const el = renderBashExecution({
            id: 'call-1',
            command: 'npm test',
            status: 'pending',
        });
        expect(el.classList.contains('tool-execution')).toBe(true);
        expect(el.classList.contains('pending')).toBe(true);
        expect(el.id).toBe('tool-call-call-1');
        expect(el.querySelector('.tool-command').textContent).toContain(
            'npm test',
        );
        expect(el.querySelector('.tool-output').textContent).toContain(
            'running',
        );
    });

    it('produces a success block with output rendered as lines', () => {
        const el = renderBashExecution({
            id: 'call-2',
            command: 'ls',
            status: 'success',
            output: 'a.txt\nb.txt',
        });
        expect(el.classList.contains('success')).toBe(true);
        const output = el.querySelector('.tool-output');
        expect(output).not.toBeNull();
        expect(output.textContent).toContain('a.txt');
        expect(output.textContent).toContain('b.txt');
    });

    it('produces an error block', () => {
        const el = renderBashExecution({
            id: 'call-3',
            command: 'false',
            status: 'error',
            output: 'exit code 1',
        });
        expect(el.classList.contains('error')).toBe(true);
        expect(el.querySelector('.tool-output').textContent).toContain(
            'exit code 1',
        );
    });

    it('folds error blocks by default and unfolds on header click', () => {
        const el = renderBashExecution({
            id: 'call-fold',
            command: 'false',
            status: 'error',
            output: 'boom',
        });
        // Folded by default; the output stays in the DOM (CSS hides it).
        expect(el.classList.contains('folded')).toBe(true);
        const output = el.querySelector('.tool-output');
        expect(output).not.toBeNull();
        expect(output.textContent).toContain('boom');

        const head = el.querySelector('.tool-command');
        head.click();
        expect(el.classList.contains('folded')).toBe(false);
        head.click();
        expect(el.classList.contains('folded')).toBe(true);
    });

    it('does not fold success blocks', () => {
        const el = renderBashExecution({
            id: 'call-nofold',
            command: 'ls',
            status: 'success',
            output: 'a.txt',
        });
        expect(el.classList.contains('folded')).toBe(false);
    });

    it('escapes HTML in command and output', () => {
        const el = renderBashExecution({
            id: 'call-x',
            command: 'echo <script>alert(1)</script>',
            status: 'success',
            output: '<img src=x onerror="alert(1)">',
        });
        expect(el.querySelector('script')).toBeNull();
        expect(el.querySelector('img')).toBeNull();
    });

    it('renders the last 20 lines with the bash expand hint', () => {
        const output = Array.from(
            { length: 25 },
            (_, i) => `line-${i + 1}`,
        ).join('\n');
        const el = renderBashExecution({
            id: 'call-tail',
            command: 'seq 25',
            status: 'success',
            output,
        });
        expect(el.querySelector('.output-preview > div').textContent).toBe(
            'line-6',
        );
        expect(el.querySelector('.expand-hint').textContent).toBe(
            '... 5 more lines (↵ to expand)',
        );
    });

    it('toggles expandable bash output from the command header', () => {
        const output = Array.from(
            { length: 25 },
            (_, i) => `line-${i + 1}`,
        ).join('\n');
        const el = renderBashExecution({
            id: 'call-toggle',
            command: 'seq 25',
            status: 'success',
            output,
        });
        const command = el.querySelector('.tool-command');
        const expandable = el.querySelector('.tool-output.expandable');
        command.click();
        expect(expandable.classList.contains('expanded')).toBe(true);
        command.click();
        expect(expandable.classList.contains('expanded')).toBe(false);
    });

    it('shows the collapse hint in full output after a header click', () => {
        const output = Array.from(
            { length: 25 },
            (_, i) => `line-${i + 1}`,
        ).join('\n');
        const el = renderBashExecution({
            id: 'call-collapse-hint',
            command: 'seq 25',
            status: 'success',
            output,
        });
        el.querySelector('.tool-command').click();
        expect(el.querySelector('.output-full .expand-hint').textContent).toBe(
            '(↵ to collapse)',
        );
    });

    it('shows the expand hint in preview after Space collapses output', () => {
        const output = Array.from(
            { length: 25 },
            (_, i) => `line-${i + 1}`,
        ).join('\n');
        const el = renderBashExecution({
            id: 'call-expand-hint',
            command: 'seq 25',
            status: 'success',
            output,
        });
        const command = el.querySelector('.tool-command');
        command.click();
        command.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: ' ',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(
            el.querySelector('.output-preview .expand-hint').textContent,
        ).toBe('... 5 more lines (↵ to expand)');
    });

    it('keeps short bash output fully visible without expand controls', () => {
        const el = renderBashExecution({
            id: 'call-short',
            command: 'pwd',
            status: 'success',
            output: '/work',
        });
        expect(el.querySelector('.tool-output.expandable')).toBeNull();
        expect(el.querySelector('.expand-hint')).toBeNull();
        expect(el.querySelector('.tool-output').textContent).toContain('/work');
    });

    it('renders an exit footer when bash error details include an exit code', () => {
        const el = renderBashExecution({
            id: 'call-exit',
            command: 'false',
            status: 'error',
            details: { exitCode: 1 },
        });
        expect(el.querySelector('.tool-status-footer').textContent).toBe(
            '(exit 1)',
        );
    });
});
